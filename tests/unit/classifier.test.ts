const assert = require('assert');
const path = require('path');

function runClassifierTests() {
  console.log('--- Running Local Classifier & Rules Tests ---');
  const { LocalClassifier } = require('../../dist/rules/classifier');
  const classifier = new LocalClassifier();

  const testCases = [
    // Chinese Greetings
    { input: '早安！', expectedCat: 'greeting', expectedLang: 'zh', expectSpam: false },
    { input: '你好呀～', expectedCat: 'greeting', expectedLang: 'zh', expectSpam: false },
    { input: '晚安！', expectedCat: 'greeting', expectedLang: 'zh', expectSpam: false },

    // English Greetings
    { input: 'Hello there!', expectedCat: 'greeting', expectedLang: 'en', expectSpam: false },
    { input: 'Good morning mate', expectedCat: 'greeting', expectedLang: 'en', expectSpam: false },

    // Japanese Greetings
    { input: 'こんにちは！', expectedCat: 'greeting', expectedLang: 'ja', expectSpam: false },
    { input: 'おはようございます', expectedCat: 'greeting', expectedLang: 'ja', expectSpam: false },

    // +rep
    { input: '+rep friendly player', expectedCat: 'rep', expectedLang: 'en', expectSpam: false },
    { input: '+rep 感谢来访！', expectedCat: 'rep', expectedLang: 'zh', expectSpam: false },

    // Compliments
    { input: 'nice profile! love the background', expectedCat: 'compliment', expectedLang: 'en', expectSpam: false },
    { input: '你的主页好漂亮呀！', expectedCat: 'compliment', expectedLang: 'zh', expectSpam: false },
    { input: 'cute artwork', expectedCat: 'compliment', expectedLang: 'en', expectSpam: false },

    // Warm social / 踩 / 脚印 / 互暖
    { input: '来踩踩～互暖一下！', expectedCat: 'warm_social', expectedLang: 'zh', expectSpam: false },
    { input: '路过留下一个脚印 🐾', expectedCat: 'warm_social', expectedLang: 'zh', expectSpam: false },
    { input: '互暖互踩～', expectedCat: 'warm_social', expectedLang: 'zh', expectSpam: false },

    // Kaomoji
    { input: '(｡･ω･｡)', expectedCat: 'kaomoji', expectSpam: false },
    { input: '(づ｡◕‿‿◕｡)づ', expectedCat: 'kaomoji', expectSpam: false },
    { input: 'ฅ^•ﻌ•^ฅ', expectedCat: 'kaomoji', expectSpam: false },

    // Steam Emoticon
    { input: ':steamhappy:', expectedCat: 'steam_emoticon', expectSpam: false },
    { input: ':cozyghost: :steamthumbsup:', expectedCat: 'steam_emoticon', expectSpam: false },

    // Unicode Emoji
    { input: '❤️❤️✨✨', expectedCat: 'emoji', expectSpam: false },
    { input: '🐾🐾🐾', expectedCat: 'emoji', expectSpam: false },

    // ASCII Art & Large multi-line symbols
    {
      input: `
░░░░░░░░░░░░░░░░░░
░░█▀▀▀▀▀▀▀▀▀▀▀▀▀█░░
░░█░░╦─╦╔╗╦─╔╗░░█░░
░░█░░║║║╠─║─║║░░█░░
░░█░░╚╩╝╚╝╩─╚╝░░█░░
░░█▄▄▄▄▄▄▄▄▄▄▄▄▄█░░
░░░░░░░░░░░░░░░░░░`,
      expectedCat: 'mixed_symbol_art',
      expectSpam: false
    },
    {
      input: `
  /\\_/\\  
 ( o.o ) 
  > ^ <  `,
      expectedCat: 'large_kaomoji',
      expectSpam: false
    },

    // Short friendly / compliment
    { input: '好耶！', expectedCat: 'compliment', expectedLang: 'zh', expectSpam: false },

    // Spam / Ads
    { input: 'Claim free skins at http://csgo-free-skins.com ! Promo code: WIN', expectedCat: 'spam', expectSpam: true },
    { input: 'Join our discord for giveaway: discord.gg/xyz123', expectedCat: 'spam', expectSpam: true },
    { input: '高价回收出刀加群 12345678', expectedCat: 'spam', expectSpam: true },
    { input: '免费领取皮肤，点击 t.me/free_bonus', expectedCat: 'spam', expectSpam: true },

    // Complex conversation -> unknown -> DeepSeek fallback
    { input: '请问你那个展柜的动画效果是用什么软件做出来的呢？', expectedCat: 'unknown', expectSpam: false }
  ];

  let passed = 0;
  for (const tc of testCases) {
    const res = classifier.classify(tc.input);

    if (tc.expectSpam) {
      assert.strictEqual(res.isSpam, true, `Expected spam for "${tc.input}"`);
      assert.strictEqual(res.category, 'spam', `Expected category 'spam' for "${tc.input}"`);
      assert.strictEqual(res.reply, '', `Expected empty reply for spam`);
    } else {
      assert.strictEqual(res.isSpam, false, `Did not expect spam for "${tc.input}"`);
      assert.strictEqual(res.category, tc.expectedCat, `Category mismatch for "${tc.input}". Got ${res.category}, expected ${tc.expectedCat}`);
      if (tc.expectedCat !== 'unknown') {
        assert.ok(res.reply.length > 0, `Expected non-empty reply for "${tc.input}"`);
        assert.notStrictEqual(res.replySource, 'DEEPSEEK', `Expected local reply for "${tc.input}"`);
      } else {
        assert.strictEqual(res.replySource, 'DEEPSEEK', `Expected DeepSeek fallback for "${tc.input}"`);
      }
    }
    passed++;
  }

  console.log(`✅ Passed all ${passed} Local Classifier & Rules test cases!`);
}

module.exports = { runClassifierTests };
if (require.main === module) runClassifierTests();
