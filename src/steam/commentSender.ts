import * as crypto from 'crypto';
import { SteamBrowserManager } from './browser';
import { Logger } from '../utils/logger';
import { SteamSessionManager } from './session';
import { SteamCommentTransport } from './transport/steamCommentTransport';
import { SteamSendErrorClassifier } from './transport/steamSendErrorClassifier';
import { SteamSendVerifier } from './transport/steamSendVerifier';
import { CommentMonitor } from './commentMonitor';

export function computeReplyFingerprint(arg1: string, arg2: string, arg3?: string): string {
  let authorSteamId = '';
  let targetSteamId = '';
  let text = '';
  if (arg3 !== undefined) {
    authorSteamId = arg1 || '';
    targetSteamId = arg2 || '';
    text = arg3 || '';
  } else {
    targetSteamId = arg1 || '';
    text = arg2 || '';
  }
  const clean = (text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const raw = `${authorSteamId}:${targetSteamId}:${clean}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export type SendConfirmationStatus =
  | 'CONFIRMED_NOT_SENT'
  | 'CONFIRMED_SENT'
  | 'SENT_MODERATION_PENDING'
  | 'TARGET_REJECTION_CONFIRMED'
  | 'TRANSIENT_COMMENT_REJECTION'
  | 'SEND_RESULT_UNCERTAIN';

export type SendResultStatus =
  | SendConfirmationStatus
  | 'SUCCESS'
  | 'ALREADY_SENT'
  | 'MODERATION_PENDING'
  | 'RATE_LIMITED'
  | 'TARGET_REJECTED'
  | 'PERMISSION_DENIED'
  | 'SESSION_INVALID'
  | 'FAILED'
  | 'FAILED_RETRYABLE'
  | 'UNCERTAIN';

export type SendFailureClass =
  | 'TRANSPORT_PRE_SEND_FAILURE'
  | 'TRANSPORT_POST_ATTEMPTED_UNKNOWN'
  | 'BUSINESS_TARGET_REJECTION'
  | 'RATE_LIMIT'
  | 'MODERATION_PENDING'
  | 'SESSION_INVALID'
  | 'UNKNOWN';

export interface SendResult {
  status: SendResultStatus;
  confirmationStatus?: SendConfirmationStatus;
  message?: string;
  commentId?: string;
  failureClass?: SendFailureClass;
  postAttempted?: boolean;
  transportPhase?: 'CONNECT' | 'PAGE_PREPARE' | 'POST_DISPATCH' | 'POST_RESPONSE' | 'VERIFY';
  errorCode?: string;
  httpStatus?: number;
  latencyMs?: number;
}

export interface CommentSenderOptions {
  sendMethod?: 'hybrid' | 'dom';
}

export class CommentSender {
  private sendMethod: 'hybrid' | 'dom';
  private transport: SteamCommentTransport;
  private verifier: SteamSendVerifier;
  private mySteamId?: string;

  constructor(
    private browserManager: SteamBrowserManager,
    private myProfileUrl: string,
    private logger: Logger,
    options?: CommentSenderOptions
  ) {
    this.sendMethod = options?.sendMethod || (process.env.SEND_METHOD === 'dom' ? 'dom' : 'hybrid');
    this.transport = new SteamCommentTransport(logger);
    this.verifier = new SteamSendVerifier(myProfileUrl, logger);
    const m = myProfileUrl.match(/\/profiles\/(\d{17})/);
    if (m) {
      this.mySteamId = m[1];
      this.verifier.setBotSteamId(m[1]);
    }
  }

  public static normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '').toLowerCase();
  }

  public async sendReply(
    targetProfileUrl: string,
    replyText: string,
    targetSteamId?: string
  ): Promise<SendResult> {
    // 1. Mandatory Target Direction Enforcement
    const normTarget = CommentSender.normalizeUrl(targetProfileUrl);
    const normMy = CommentSender.normalizeUrl(this.myProfileUrl);

    if (normTarget === normMy) {
      this.logger.error('TARGET_DIRECTION_VIOLATION', {
        reason: 'Attempted to post reply on own profile. Operation strictly blocked!',
        targetProfileUrl
      });
      return {
        status: 'FAILED_RETRYABLE',
        confirmationStatus: 'CONFIRMED_NOT_SENT',
        message: 'Forbidden: Target profile is identical to own profile.'
      };
    }

    if (this.sendMethod === 'dom') {
      return this.sendReplyViaDom(targetProfileUrl, replyText);
    }

    return this.sendReplyViaHybrid(targetProfileUrl, replyText, targetSteamId);
  }

  /**
   * Primary Send Mechanism: Hybrid HTTP POST inside authenticated browser context.
   * Fully decoupled Transport, Classification, and Session Re-check.
   */
  private async sendReplyViaHybrid(
    targetProfileUrl: string,
    replyText: string,
    targetSteamId?: string
  ): Promise<SendResult> {
    const sendStartedAt = Date.now();
    let postAttemptedAt: number | null = null;
    let postAttempted = false;

    this.logger.info('SEND_ATTEMPT', {
      targetProfileUrl,
      targetSteamId,
      textLength: replyText.length,
      method: 'hybrid',
      sendStartedAt
    });

    const page = await this.browserManager.openEphemeralPage();

    try {
      // 1. Navigate to target profile to establish same-origin context and cookies
      await page.goto(targetProfileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // 2. Pre-send session health check
      const sessionCheck = await SteamSessionManager.checkLightweightSession(page);
      this.logger.info('SEND_SESSION_CHECK', {
        targetProfileUrl,
        valid: sessionCheck.valid,
        hasSessionId: sessionCheck.hasSessionId,
        hasLoginCookie: sessionCheck.hasLoginCookie,
        steamId: sessionCheck.steamId
      });

      if (sessionCheck.steamId) {
        this.mySteamId = sessionCheck.steamId;
        if (this.verifier && typeof this.verifier.setBotSteamId === 'function') {
          this.verifier.setBotSteamId(sessionCheck.steamId);
        }
      }

      if (!sessionCheck.valid) {
        this.logger.warn('SEND_SESSION_INVALID_PRECHECK', {
          targetProfileUrl,
          reason: sessionCheck.reason || 'UNAUTHENTICATED'
        });
        return {
          status: 'SESSION_INVALID',
          confirmationStatus: 'CONFIRMED_NOT_SENT',
          message: `Pre-send session check failed: ${sessionCheck.reason || 'User not logged in to Steam'}`
        };
      }

      // 3. Check for pre-send DOM restriction on target profile
      const domRestricted = await this.verifier.checkTargetDomRestricted(page);
      if (domRestricted) {
        this.logger.warn('SEND_RESULT_CLASSIFIED', {
          targetProfileUrl,
          result: 'PERMISSION_DENIED',
          reason: 'TARGET_RESTRICTED',
          globalSessionInvalid: false
        });
        return {
          status: 'PERMISSION_DENIED',
          confirmationStatus: 'TARGET_REJECTION_CONFIRMED',
          message: 'TARGET_RESTRICTED: Target profile comments are restricted with confirmed DOM notice'
        };
      }

      // 4. Resolve Target SteamID64
      const STEAMID64_REGEX = /^\d{17}$/;
      let resolvedSteamId = '';
      let resolutionSource = '';

      // Priority 1: Check if targetSteamId passed as argument is already a valid 17-digit numeric SteamID64
      if (targetSteamId && STEAMID64_REGEX.test(targetSteamId.trim())) {
        resolvedSteamId = targetSteamId.trim();
        resolutionSource = 'arg_target_steam_id';
      }

      // Priority 2: Check if targetProfileUrl contains numeric /profiles/(\d{17})
      if (!resolvedSteamId && targetProfileUrl) {
        const urlMatch = targetProfileUrl.match(/\/profiles\/(\d{17})/);
        if (urlMatch) {
          resolvedSteamId = urlMatch[1];
          resolutionSource = 'target_profile_url';
        }
      }

      // Priority 3: Resolve from loaded target profile page DOM via openEphemeralPage()
      if (!resolvedSteamId) {
        try {
          const domResult = await page.evaluate(() => {
            // (a) Profile data object: window.g_rgProfileData.steamid
            const profileData = (window as any).g_rgProfileData;
            if (profileData && profileData.steamid && /^\d{17}$/.test(String(profileData.steamid).trim())) {
              return { steamId: String(profileData.steamid).trim(), source: 'g_rgProfileData' };
            }

            // (b) Comment thread form ID: commentthread_Profile_7656119..._form
            const form = document.querySelector('form[id^="commentthread_Profile_"]');
            if (form && form.id) {
              const m = form.id.match(/commentthread_Profile_(\d{17})_/);
              if (m) return { steamId: m[1], source: 'commentthread_form_id' };
            }

            // (c) data-miniprofile on profile page
            const miniEl = document.querySelector('.responsive_status_info [data-miniprofile], .profile_header_content [data-miniprofile], [data-miniprofile]');
            const mini = miniEl ? miniEl.getAttribute('data-miniprofile') : null;
            if (mini) {
              const trimmed = mini.trim();
              if (/^\d{17}$/.test(trimmed)) {
                return { steamId: trimmed, source: 'dom_miniprofile_64' };
              }
              if (/^\d{1,10}$/.test(trimmed)) {
                try {
                  const id64 = (76561197960265728n + BigInt(trimmed)).toString();
                  if (/^\d{17}$/.test(id64)) {
                    return { steamId: id64, source: 'dom_miniprofile_account_id' };
                  }
                } catch {
                  // ignore
                }
              }
            }

            // (d) Canonical profile links or action links containing 17-digit steamid
            const profileLinks = Array.from(document.querySelectorAll('a[href*="/profiles/"]'));
            for (const a of profileLinks) {
              const href = a.getAttribute('href') || '';
              const m = href.match(/\/profiles\/(\d{17})/);
              if (m) {
                return { steamId: m[1], source: 'dom_profile_link' };
              }
            }

            return null;
          });

          if (domResult && domResult.steamId && STEAMID64_REGEX.test(domResult.steamId)) {
            resolvedSteamId = domResult.steamId;
            resolutionSource = domResult.source;
          }
        } catch (e: any) {
          this.logger.warn('RESOLVE_STEAMID_DOM_ERROR', {
            targetProfileUrl,
            error: e.message || String(e)
          });
        }
      }

      // Safety check: resolvedSteamId MUST be a valid 17-digit SteamID64
      if (!resolvedSteamId || !STEAMID64_REGEX.test(resolvedSteamId)) {
        this.logger.error('TARGET_STEAM_ID_RESOLUTION_FAILED', {
          targetProfileUrl,
          originalTargetSteamId: targetSteamId || null,
          resolutionSource: resolutionSource || 'none',
          resolvedSteamId: resolvedSteamId || null,
          reason: 'Failed to resolve valid 17-digit numeric SteamID64'
        });
        return {
          status: 'FAILED_RETRYABLE',
          confirmationStatus: 'CONFIRMED_NOT_SENT',
          message: 'TARGET_STEAM_ID_RESOLUTION_FAILED: Could not resolve valid 17-digit SteamID64'
        };
      }

      // 5. Dispatch HTTP POST via dedicated Transport Layer
      this.logger.info('SEND_TRANSPORT', {
        targetProfileUrl,
        targetSteamId: resolvedSteamId,
        resolutionSource
      });

      postAttempted = true;
      postAttemptedAt = Date.now();
      const transportResult = await this.transport.postComment(page, {
        targetSteamId64: resolvedSteamId,
        commentText: replyText,
        count: 6,
        targetProfileUrl
      });

      // 6. Log Raw Response
      const rawJson = transportResult.rawJson || {};
      const isSuccess = Boolean(rawJson.success);
      const errorStr = rawJson.error ? String(rawJson.error) : undefined;
      const commentsHtml = typeof rawJson.comments_html === 'string' ? rawJson.comments_html : '';

      this.logger.info('SEND_RAW_RESPONSE', {
        targetSteamId: resolvedSteamId,
        targetProfileUrl,
        httpStatus: transportResult.httpStatus,
        success: isSuccess,
        steamError: errorStr,
        hasCommentsHtml: commentsHtml.length > 0,
        networkError: transportResult.networkError
      });

      // 7. Classify Result via dedicated Error Classifier
      const classified = SteamSendErrorClassifier.classify(transportResult);

      this.logger.info('SEND_RESULT_CLASSIFIED', {
        targetSteamId: resolvedSteamId,
        classifiedStatus: classified.status,
        rawError: classified.rawError,
        message: classified.message,
        globalSessionInvalid: classified.status === 'POTENTIAL_SESSION_INVALID'
      });

      // Helper verify options bundle
      const verifyOpts = {
        expectedText: replyText,
        botSteamId: sessionCheck.steamId || this.mySteamId,
        botProfileUrl: this.myProfileUrl,
        targetSteamId: resolvedSteamId,
        sendStartedAt,
        postAttemptedAt,
        verifyStartedAt: Date.now()
      };

      // 8. Handle Classified Status
      switch (classified.status) {
        case 'SUCCESS': {
          const parsedCommentId = classified.parsedCommentId;
          this.logger.info('SEND_SUBMITTED', {
            targetProfileUrl,
            parsedCommentId
          });

          // Check if returned comments_html contains moderation placeholder
          if (classified.commentsHtml) {
            const modDetect = this.checkModerationInHtml(classified.commentsHtml);
            if (modDetect) {
              this.logger.warn('SEND_VERIFY_MODERATION_PENDING', {
                targetProfileUrl,
                parsedCommentId,
                reason: 'Steam returned success but comments_html exhibits automated moderation placeholder'
              });
              return {
                status: 'MODERATION_PENDING',
                confirmationStatus: 'SENT_MODERATION_PENDING',
                message: 'Comment submitted but awaiting Steam content check',
                commentId: parsedCommentId
              };
            }
          }

          // Target Profile Verification (SUBMITTED != REPLIED)
          const verifyStatus = await this.doVerifyOnTargetProfile(
            page,
            targetProfileUrl,
            { ...verifyOpts, parsedCommentId }
          );

          if (verifyStatus === 'FOUND') {
            this.logger.info('SEND_VERIFIED', {
              targetProfileUrl,
              parsedCommentId,
              verifiedStatus: 'CONFIRMED_ON_TARGET_PROFILE'
            });
            return {
              status: 'SUCCESS',
              confirmationStatus: 'CONFIRMED_SENT',
              commentId: parsedCommentId
            };
          } else if (verifyStatus === 'MODERATION_PENDING') {
            this.logger.warn('SEND_VERIFY_MODERATION_PENDING', {
              targetProfileUrl,
              parsedCommentId,
              reason: 'Target profile displays moderation placeholder after submission'
            });
            return {
              status: 'MODERATION_PENDING',
              confirmationStatus: 'SENT_MODERATION_PENDING',
              message: 'Comment submitted but awaiting Steam content check',
              commentId: parsedCommentId
            };
          } else if (verifyStatus === 'VERIFY_FAILED') {
            this.logger.warn('SEND_VERIFY_TIMED_OUT_UNCERTAIN', {
              targetProfileUrl,
              parsedCommentId,
              reason: 'Page verification failed or timed out after successful POST'
            });
            return {
              status: 'UNCERTAIN',
              confirmationStatus: 'SEND_RESULT_UNCERTAIN',
              message: 'Comment submitted but page verification failed or timed out',
              commentId: parsedCommentId
            };
          } else {
            // Submitted to Steam successfully, but not yet indexed/visible on target page
            this.logger.warn('SEND_UNCERTAIN', {
              targetProfileUrl,
              parsedCommentId,
              reason: 'Steam POST returned success but target profile verification did not find comment yet'
            });
            return {
              status: 'UNCERTAIN',
              confirmationStatus: 'SEND_RESULT_UNCERTAIN',
              message: 'Comment submitted but not confirmed on target profile',
              commentId: parsedCommentId
            };
          }
        }

        case 'TARGET_REJECTION_CANDIDATE':
        case 'TARGET_REJECTED': {
          this.logger.info('SEND_CANDIDATE_RECHECKING', {
            targetProfileUrl,
            candidateStatus: classified.status,
            rawError: classified.rawError
          });

          const recheck = await SteamSessionManager.checkLightweightSession(page);
          this.logger.info('SEND_SESSION_RECHECK', {
            targetProfileUrl,
            valid: recheck.valid,
            steamId: recheck.steamId,
            hasSessionId: recheck.hasSessionId,
            hasLoginCookie: recheck.hasLoginCookie
          });

          if (!recheck.valid) {
            this.logger.warn('SEND_SESSION_INVALID_POSTCHECK', {
              targetProfileUrl,
              reason: recheck.reason || 'Session invalid or expired during comment submission'
            });
            return {
              status: 'SESSION_INVALID',
              confirmationStatus: 'SEND_RESULT_UNCERTAIN',
              message: `Session invalid: ${recheck.reason || 'User session lost'}`
            };
          }

          // Session confirmed VALID -> Do NOT assume TARGET_REJECTED!
          // Enter PENDING_VERIFICATION on target profile page with dual check:
          this.logger.info('SEND_REJECTION_PENDING_VERIFICATION', {
            targetProfileUrl,
            reason: 'Steam returned rejection but session is valid. Verifying target profile DOM with dual check.'
          });

          return await this.verifyTransientRejectionWithDualCheck(
            page,
            targetProfileUrl,
            resolvedSteamId,
            verifyOpts,
            classified
          );
        }

        case 'RATE_LIMITED': {
          this.logger.warn('SEND_RATE_LIMITED', {
            targetProfileUrl,
            error: classified.rawError
          });
          return {
            status: 'RATE_LIMITED',
            confirmationStatus: 'SEND_RESULT_UNCERTAIN',
            message: classified.message || 'Rate limit exceeded on Steam comments'
          };
        }

        case 'DUPLICATE': {
          this.logger.warn('SEND_ALREADY_SENT', {
            targetProfileUrl,
            error: classified.rawError
          });
          return {
            status: 'ALREADY_SENT',
            confirmationStatus: 'CONFIRMED_SENT',
            message: classified.message || 'Comment already posted'
          };
        }

        case 'STEAM_TRANSIENT_ERROR': {
          this.logger.warn('SEND_TRANSIENT_ERROR', {
            targetProfileUrl,
            error: classified.rawError
          });
          const verifyStatus = await this.doVerifyOnTargetProfile(page, targetProfileUrl, verifyOpts);
          if (verifyStatus === 'FOUND') {
            return {
              status: 'SUCCESS',
              confirmationStatus: 'CONFIRMED_SENT',
              message: 'Comment posted and verified on profile despite transient error'
            };
          }
          if (verifyStatus === 'MODERATION_PENDING') {
            return {
              status: 'MODERATION_PENDING',
              confirmationStatus: 'SENT_MODERATION_PENDING',
              message: 'Comment submitted but awaiting Steam content check'
            };
          }
          if (verifyStatus === 'VERIFY_FAILED') {
            return {
              status: 'UNCERTAIN',
              confirmationStatus: 'SEND_RESULT_UNCERTAIN',
              message: 'Send state uncertain: verification failed after POST'
            };
          }
          return {
            status: 'FAILED_RETRYABLE',
            confirmationStatus: 'TRANSIENT_COMMENT_REJECTION',
            message: classified.message || 'Steam Community server transient error'
          };
        }

        case 'NETWORK_ERROR': {
          this.logger.warn('SEND_NETWORK_ERROR_VERIFYING', {
            targetProfileUrl,
            networkError: classified.rawError
          });
          const verifyStatus = await this.doVerifyOnTargetProfile(page, targetProfileUrl, verifyOpts);
          if (verifyStatus === 'FOUND') {
            return {
              status: 'SUCCESS',
              confirmationStatus: 'CONFIRMED_SENT',
              message: 'Comment posted and verified on profile despite network error'
            };
          }
          if (verifyStatus === 'MODERATION_PENDING') {
            return {
              status: 'MODERATION_PENDING',
              confirmationStatus: 'SENT_MODERATION_PENDING',
              message: 'Comment submitted but awaiting Steam content check'
            };
          }
          return {
            status: 'UNCERTAIN',
            confirmationStatus: 'SEND_RESULT_UNCERTAIN',
            message: classified.message || 'Network error during Steam HTTP POST'
          };
        }

        case 'POTENTIAL_SESSION_INVALID': {
          // Authoritative Session Re-check
          this.logger.warn('SEND_POTENTIAL_SESSION_INVALID', {
            targetProfileUrl,
            rawError: classified.rawError
          });

          const recheck = await SteamSessionManager.checkLightweightSession(page);
          this.logger.info('SEND_SESSION_RECHECK', {
            valid: recheck.valid,
            steamId: recheck.steamId,
            hasSessionId: recheck.hasSessionId,
            hasLoginCookie: recheck.hasLoginCookie
          });

          if (!recheck.valid) {
            // Truly unauthenticated session
            return {
              status: 'SESSION_INVALID',
              confirmationStatus: 'SEND_RESULT_UNCERTAIN',
              message: classified.message || 'Steam session invalid or expired'
            };
          }

          // Session is actually VALID! Do NOT classify as SESSION_INVALID!
          this.logger.info('SEND_SESSION_RECHECK_PASSED', {
            targetProfileUrl,
            reason: 'Session confirmed healthy upon recheck, verifying target profile with dual check'
          });

          return await this.verifyTransientRejectionWithDualCheck(
            page,
            targetProfileUrl,
            resolvedSteamId,
            verifyOpts,
            classified
          );
        }

        case 'UNKNOWN_STEAM_ERROR':
        default: {
          // Perform lightweight session recheck to avoid any false positive session invalidation
          const recheck = await SteamSessionManager.checkLightweightSession(page);
          if (!recheck.valid) {
            return {
              status: 'SESSION_INVALID',
              confirmationStatus: 'SEND_RESULT_UNCERTAIN',
              message: classified.message || 'Steam session invalid'
            };
          }

          this.logger.error('SEND_FAILED', {
            targetProfileUrl,
            error: classified.rawError,
            reason: 'UNKNOWN_STEAM_ERROR'
          });
          return {
            status: 'FAILED',
            confirmationStatus: 'SEND_RESULT_UNCERTAIN',
            message: classified.message || 'Unknown Steam comment failure'
          };
        }
      }
    } catch (e: any) {
      const latencyMs = Date.now() - sendStartedAt;
      if (!postAttempted) {
        this.logger.warn('SEND_FAILURE_CLASSIFIED', {
          class: 'TRANSPORT_PRE_SEND_FAILURE',
          phase: 'CONNECT',
          errorCode: e.code || 'CONNECT_ERROR',
          targetProfileUrl,
          postAttempted: false,
          retryable: true,
          error: e.message,
          latencyMs
        });
        return {
          status: 'FAILED_RETRYABLE',
          confirmationStatus: 'CONFIRMED_NOT_SENT',
          message: `POST_NOT_ATTEMPTED: ${e.message}`,
          failureClass: 'TRANSPORT_PRE_SEND_FAILURE',
          postAttempted: false,
          transportPhase: 'CONNECT',
          errorCode: e.code || 'CONNECT_ERROR',
          latencyMs
        };
      }

      this.logger.warn('SEND_FAILURE_CLASSIFIED', {
        class: 'TRANSPORT_POST_ATTEMPTED_UNKNOWN',
        phase: 'POST_RESPONSE',
        errorCode: e.code || 'POST_RESPONSE_ERROR',
        targetProfileUrl,
        postAttempted: true,
        retryable: false,
        error: e.message,
        latencyMs
      });
      return {
        status: 'UNCERTAIN',
        confirmationStatus: 'SEND_RESULT_UNCERTAIN',
        message: e.message,
        failureClass: 'TRANSPORT_POST_ATTEMPTED_UNKNOWN',
        postAttempted: true,
        transportPhase: 'POST_RESPONSE',
        errorCode: e.code || 'POST_RESPONSE_ERROR',
        latencyMs
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Safe wrapper around target profile verification to handle different verifier implementations or mock verifiers.
   */
  private async doVerifyOnTargetProfile(
    page: any,
    targetProfileUrl: string,
    opts: VerifyCommentOptions
  ): Promise<PageVerificationResult> {
    if (this.verifier && typeof this.verifier.verifyOnTargetProfile === 'function') {
      return this.verifier.verifyOnTargetProfile(page, targetProfileUrl, opts);
    }
    if (this.verifier && typeof this.verifier.verifyCommentInPage === 'function') {
      return this.verifier.verifyCommentInPage(page, opts);
    }
    return 'VERIFY_FAILED';
  }

  /**
   * Safety Rule 1: Executes dual independent fresh verifications before concluding TRANSIENT_COMMENT_REJECTION.
   */
  private async verifyTransientRejectionWithDualCheck(
    page: any,
    targetProfileUrl: string,
    resolvedSteamId: string,
    verifyOpts: VerifyCommentOptions,
    classified: any
  ): Promise<SendResult> {
    // 1. First verification on target profile
    const verifyStatus1 = await this.doVerifyOnTargetProfile(page, targetProfileUrl, verifyOpts);

    if (verifyStatus1 === 'FOUND') {
      this.logger.info('SEND_OVERRIDDEN_API_FALSE_BUT_COMMENT_FOUND', {
        targetProfileUrl,
        verifiedStatus: 'CONFIRMED_ON_TARGET_PROFILE'
      });
      return {
        status: 'SUCCESS',
        confirmationStatus: 'CONFIRMED_SENT',
        message: 'Comment posted and verified on profile despite Steam API rejection response'
      };
    }

    if (verifyStatus1 === 'MODERATION_PENDING') {
      this.logger.warn('SEND_OVERRIDDEN_API_FALSE_BUT_MODERATION_PENDING', {
        targetProfileUrl,
        reason: 'Steam API reported error but target profile exhibits automated moderation placeholder'
      });
      return {
        status: 'MODERATION_PENDING',
        confirmationStatus: 'SENT_MODERATION_PENDING',
        message: 'Comment submitted but awaiting Steam content check'
      };
    }

    if (verifyStatus1 === 'VERIFY_FAILED') {
      this.logger.warn('SEND_VERIFY_TIMED_OUT_UNCERTAIN', {
        targetProfileUrl,
        reason: 'Verification on target profile failed or timed out after POST'
      });
      return {
        status: 'UNCERTAIN',
        confirmationStatus: 'SEND_RESULT_UNCERTAIN',
        message: 'Send state uncertain: verification failed after POST'
      };
    }

    // Check if target profile DOM has confirmed restriction elements (e.g. comments closed or friends-only)
    // or error explicitly indicates friends-only / locked thread
    const isExplicitRestriction =
      Boolean(classified.rawError) &&
      (classified.rawError.toLowerCase().includes('friends to post comments') ||
        classified.rawError.toLowerCase().includes('only allow friends') ||
        classified.rawError.toLowerCase().includes('only friends') ||
        classified.rawError.toLowerCase().includes('thread is locked') ||
        classified.rawError.toLowerCase().includes('commenting has been disabled'));

    const domRestricted1 = await this.verifier.checkTargetDomRestricted(page);
    if (domRestricted1 || isExplicitRestriction) {
      this.logger.warn('SEND_RESULT_CLASSIFIED', {
        targetProfileUrl,
        targetSteamId: resolvedSteamId,
        result: 'TARGET_REJECTED',
        confirmationStatus: 'TARGET_REJECTION_CONFIRMED',
        steamError: classified.rawError,
        globalSessionInvalid: false
      });
      return {
        status: 'PERMISSION_DENIED',
        confirmationStatus: 'TARGET_REJECTION_CONFIRMED',
        message: `TARGET_REJECTION_CONFIRMED: ${classified.message || 'Target user settings do not allow comments'}`
      };
    }

    // Safety Rule 1: First check yielded NOT_FOUND on an open profile.
    // MUST perform a SECOND independent fresh verification before concluding TRANSIENT_COMMENT_REJECTION!
    this.logger.info('SEND_VERIFY_SECOND_CHECK_STARTED', {
      targetProfileUrl,
      reason: 'First verification yielded NOT_FOUND on open profile. Waiting short window for second fresh verification.'
    });

    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(2000).catch(() => {});
    }

    const verifyStatus2 = await this.doVerifyOnTargetProfile(page, targetProfileUrl, {
      ...verifyOpts,
      verifyStartedAt: Date.now()
    });

    if (verifyStatus2 === 'FOUND') {
      this.logger.info('SEND_OVERRIDDEN_API_FALSE_BUT_COMMENT_FOUND_ON_RECHECK', {
        targetProfileUrl,
        verifiedStatus: 'CONFIRMED_ON_TARGET_PROFILE'
      });
      return {
        status: 'SUCCESS',
        confirmationStatus: 'CONFIRMED_SENT',
        message: 'Comment posted and verified on profile on second check'
      };
    }

    if (verifyStatus2 === 'MODERATION_PENDING') {
      this.logger.warn('SEND_OVERRIDDEN_API_FALSE_BUT_MODERATION_PENDING_ON_RECHECK', {
        targetProfileUrl
      });
      return {
        status: 'MODERATION_PENDING',
        confirmationStatus: 'SENT_MODERATION_PENDING',
        message: 'Comment submitted but awaiting Steam content check (detected on second check)'
      };
    }

    if (verifyStatus2 === 'VERIFY_FAILED') {
      this.logger.warn('SEND_VERIFY_SECOND_CHECK_FAILED_UNCERTAIN', {
        targetProfileUrl,
        reason: 'Second verification on target profile failed or timed out'
      });
      return {
        status: 'UNCERTAIN',
        confirmationStatus: 'SEND_RESULT_UNCERTAIN',
        message: 'Send state uncertain: second verification failed after POST'
      };
    }

    const domRestricted2 = await this.verifier.checkTargetDomRestricted(page);
    if (domRestricted2) {
      return {
        status: 'PERMISSION_DENIED',
        confirmationStatus: 'TARGET_REJECTION_CONFIRMED',
        message: `TARGET_REJECTION_CONFIRMED: ${classified.message || 'Target user settings do not allow comments'}`
      };
    }

    // Both independent fresh checks cleanly confirmed:
    // - No Bot comment
    // - No moderation pending
    // - Page loaded normally
    // - Comment area explicitly open
    // - No confirmed target restriction
    this.logger.warn('SEND_TRANSIENT_COMMENT_REJECTION', {
      targetProfileUrl,
      targetSteamId: resolvedSteamId,
      error: classified.rawError,
      checksCompleted: 2
    });
    return {
      status: 'FAILED_RETRYABLE',
      confirmationStatus: 'TRANSIENT_COMMENT_REJECTION',
      message: `TRANSIENT_COMMENT_REJECTION: ${classified.message || 'Transient comment rejection on open profile verified twice'}`
    };
  }

  private checkModerationInHtml(html: string): boolean {
    return (
      html.includes('等待我们的自动内容检查系统分析') ||
      html.includes('awaiting analysis by our automated content check system')
    );
  }

  /**
   * Public check for existing comment on target profile (for crash recovery / idempotency / pre-retry safety gate).
   */
  public async checkTargetProfileForExistingComment(
    targetProfileUrl: string,
    expectedText: string,
    parsedCommentIdOrOptions?: string | {
      targetSteamId?: string;
      ourSteamId?: string;
      startedAt?: string;
      parsedCommentId?: string;
      replyFingerprint?: string;
      postAttemptedAt?: number;
    }
  ): Promise<'FOUND' | 'NOT_FOUND' | 'MODERATION_PENDING' | 'RESTRICTED' | 'UNCERTAIN'> {
    const opts = typeof parsedCommentIdOrOptions === 'object' && parsedCommentIdOrOptions !== null
      ? parsedCommentIdOrOptions
      : { parsedCommentId: parsedCommentIdOrOptions };

    let page: any = null;
    try {
      page = await this.browserManager.openEphemeralPage();
      const freshUrl = targetProfileUrl.includes('?')
        ? `${targetProfileUrl}&_t=${Date.now()}`
        : `${targetProfileUrl}?_t=${Date.now()}`;

      await page.goto(freshUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 25000
      });

      // Check if target profile comment section is confirmed restricted
      const isRestricted = await this.verifier.checkTargetDomRestricted(page).catch(() => false);
      if (isRestricted) {
        return 'RESTRICTED';
      }

      await page.waitForSelector('.commentthread_comments, .profile_comment_area', { timeout: 10000 }).catch(() => {});

      const postAttemptedAtMs = opts.postAttemptedAt || (opts.startedAt ? new Date(opts.startedAt).getTime() : undefined);

      // Page 1 verification
      let res = await this.verifier.verifyCommentInPage(page, {
        expectedText,
        parsedCommentId: opts.parsedCommentId,
        botSteamId: opts.ourSteamId || this.mySteamId,
        botProfileUrl: this.myProfileUrl,
        postAttemptedAt: postAttemptedAtMs
      });

      if (res === 'FOUND' || res === 'MODERATION_PENDING') {
        return res;
      }

      // Unified Catch-Up Pagination: Reuse CommentMonitor.triggerNextPage
      // Search backwards through comment thread within target time window up to max safety cap (10 pages)
      if (res === 'NOT_FOUND' || res === 'VERIFY_FAILED') {
        const MAX_VERIFY_PAGES = 10;
        let verifyPage = 1;

        while (verifyPage < MAX_VERIFY_PAGES) {
          const paged = await CommentMonitor.triggerNextPage(page);
          if (!paged) {
            // No more pages / disabled next button; reached natural end of thread
            break;
          }
          verifyPage++;

          const deeperRes = await this.verifier.verifyCommentInPage(page, {
            expectedText,
            parsedCommentId: opts.parsedCommentId,
            botSteamId: opts.ourSteamId || this.mySteamId,
            botProfileUrl: this.myProfileUrl,
            postAttemptedAt: postAttemptedAtMs
          });

          if (deeperRes === 'FOUND' || deeperRes === 'MODERATION_PENDING') {
            return deeperRes;
          }

          if (deeperRes === 'VERIFY_FAILED') {
            // Page verification failed or had network/DOM glitch: strictly return UNCERTAIN!
            return 'UNCERTAIN';
          }

          // Check if comments on this page have moved past the postAttemptedAt time window
          if (postAttemptedAtMs) {
            const minTimestampSec = Math.floor(postAttemptedAtMs / 1000) - 120;
            const commentsOnPage = await page.$$eval(
              '.commentthread_comment, [data-timestamp]',
              (elements: any[]) => {
                const ts: number[] = [];
                for (const el of elements) {
                  const tEl = el.querySelector ? el.querySelector('[data-timestamp]') : null;
                  const raw = (tEl ? tEl.getAttribute('data-timestamp') : null) || (el.getAttribute ? el.getAttribute('data-timestamp') : null);
                  if (raw) {
                    const parsed = parseInt(raw, 10);
                    if (!isNaN(parsed)) ts.push(parsed);
                  }
                }
                return ts;
              }
            ).catch(() => []);

            if (commentsOnPage.length > 0) {
              const allOlder = commentsOnPage.every((ts: number) => ts < minTimestampSec);
              if (allOlder) {
                // Reached comments older than send window; safe to stop searching
                break;
              }
            }
          }
        }
      }

      if (res === 'VERIFY_FAILED') return 'UNCERTAIN';
      return res;
    } catch (e: any) {
      this.logger.warn('CHECK_EXISTING_COMMENT_ERROR', { error: e.message, isNetworkError: true });
      return 'UNCERTAIN';
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  /**
   * Legacy Fallback Mechanism: Playwright DOM typing & button click.
   */
  private async sendReplyViaDom(targetProfileUrl: string, replyText: string): Promise<SendResult> {
    const page = await this.browserManager.openEphemeralPage();

    try {
      this.logger.info('SEND_OPEN_TARGET', {
        targetProfileUrl,
        textPreview: replyText.substring(0, 30),
        method: 'dom_legacy'
      });

      await page.goto(targetProfileUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      const commentsRestricted = await this.verifier.checkTargetDomRestricted(page);
      if (commentsRestricted) {
        this.logger.warn('SEND_PERMISSION_DENIED', { targetProfileUrl });
        return {
          status: 'TARGET_REJECTED',
          message: 'Target profile comments are restricted to friends or private.'
        };
      }

      const textareaSelector = [
        'textarea.commentthread_textarea',
        '.commentthread_entry_area textarea',
        '#commentthread_Profile_0_textarea',
        'textarea[name="comment"]'
      ].join(', ');

      const textareaEl = await page.waitForSelector(textareaSelector, { timeout: 10000 }).catch(() => null);
      if (!textareaEl) {
        this.logger.warn('SEND_UNCERTAIN', { targetProfileUrl, reason: 'Textarea not found or comments disabled' });
        return {
          status: 'UNCERTAIN',
          message: 'Comment textarea not found on target profile'
        };
      }

      await textareaEl.click();
      await textareaEl.fill(replyText);

      const submitSelector = [
        'a.commentthread_comment_submitbtn',
        '.commentthread_entry_area .btn_green_white_innerfade',
        '#commentthread_Profile_0_submit',
        '.commentthread_entry_area a[href*="PostComment"]',
        '.commentthread_entry_area button',
        '.commentthread_entry_area [id*="submit"]'
      ].join(', ');

      const submitEl = await page.waitForSelector(submitSelector, { timeout: 8000 }).catch(() => null);
      if (!submitEl) {
        await textareaEl.dispatchEvent('input').catch(() => {});
        await textareaEl.dispatchEvent('change').catch(() => {});
      }

      const finalSubmitEl = submitEl || (await page.waitForSelector(submitSelector, { timeout: 4000 }).catch(() => null));
      this.logger.info('SEND_POSTING', { targetProfileUrl, method: 'dom_legacy' });

      if (finalSubmitEl) {
        await finalSubmitEl.click();
      } else {
        await page.evaluate(() => {
          const btn = document.querySelector('.commentthread_comment_submitbtn') as HTMLElement;
          if (btn) btn.click();
        });
      }

      this.logger.info('SEND_SUBMITTED', { targetProfileUrl, method: 'dom_legacy' });
      await page.waitForTimeout(4000);

      const verified = await this.verifier.verifyOnTargetProfile(page, targetProfileUrl, replyText);

      if (verified === 'FOUND') {
        this.logger.info('SEND_VERIFIED', { targetProfileUrl });
        return { status: 'SUCCESS' };
      } else if (verified === 'MODERATION_PENDING') {
        this.logger.warn('SEND_VERIFY_MODERATION_PENDING', { targetProfileUrl });
        return {
          status: 'MODERATION_PENDING',
          message: 'Comment submitted but awaiting Steam content check'
        };
      } else {
        this.logger.warn('SEND_UNCERTAIN', { targetProfileUrl, reason: 'Comment not found in thread after DOM submit' });
        return { status: 'UNCERTAIN', message: 'Comment not found in thread after DOM submit' };
      }
    } catch (e: any) {
      this.logger.error('SEND_FAILED', { targetProfileUrl, error: e.message });
      return { status: 'UNCERTAIN', message: e.message };
    } finally {
      await page.close().catch(() => {});
    }
  }
}
