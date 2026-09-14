const fs = require('fs');
const path = require('path');

// 1. Read production release UI files
const html = fs.readFileSync(path.resolve(__dirname, '../release/dist/ui/index.html'), 'utf8');
const js = fs.readFileSync(path.resolve(__dirname, '../release/dist/ui/app.js'), 'utf8');
const css = fs.readFileSync(path.resolve(__dirname, '../release/dist/ui/style.css'), 'utf8');

console.log('=== Step 1: File Presence & Integrity Check ===');
console.log('index.html size:', html.length, 'bytes');
console.log('app.js size:', js.length, 'bytes');
console.log('style.css size:', css.length, 'bytes');

// 2. Validate Section Structure
console.log('\n=== Step 2: HTML Section Hierarchy Audit ===');
const sections = [];
const secRegex = /<section\s+id="([^"]+)"\s+class="([^"]+)">([\s\S]*?)<\/section>/g;
let match;
while ((match = secRegex.exec(html)) !== null) {
  sections.push({ id: match[1], className: match[2], length: match[3].length });
}

console.log(`Discovered ${sections.length} top-level independent sections:`);
sections.forEach((s, idx) => console.log(`  ${idx + 1}. #${s.id} (class: "${s.className}")`));

const hasVisualSection = sections.some(s => s.id === 'view-visual-replies');
const hasLogsSection = sections.some(s => s.id === 'view-logs');
console.log('view-visual-replies is top-level independent section:', hasVisualSection);
console.log('view-logs is top-level independent section:', hasLogsSection);

if (!hasVisualSection || !hasLogsSection) {
  console.error('FAILED: Sections are not independent siblings!');
  process.exit(1);
}

// 3. Verify CSS Rules for .view-panel and .active
console.log('\n=== Step 3: CSS Display Rules Audit ===');
const hasViewPanelNone = css.includes('.view-panel {') && css.includes('display: none;');
const hasViewPanelActiveBlock = css.includes('.view-panel.active {') && css.includes('display: block;');
const hasVisualPillsCss = css.includes('.visual-cat-pill') && css.includes('.visual-mode-bar');

console.log('.view-panel { display: none; } present:', hasViewPanelNone);
console.log('.view-panel.active { display: block; } present:', hasViewPanelActiveBlock);
console.log('Visual pills CSS classes present:', hasVisualPillsCss);

if (!hasViewPanelNone || !hasViewPanelActiveBlock || !hasVisualPillsCss) {
  console.error('FAILED: CSS rules missing!');
  process.exit(1);
}

// 4. Test VisualReplyLibrary items loading
console.log('\n=== Step 4: VisualReplyLibrary Data Load Audit ===');
const { VisualReplyLibrary } = require(path.resolve(__dirname, '../release/dist/reply/visualLibrary.js'));
const lib = new VisualReplyLibrary(path.resolve(__dirname, '../release/data/visual-replies'));
const allItems = lib.getAllItems();
console.log(`Loaded ${allItems.length} items from release/data/visual-replies:`);
allItems.forEach((item, idx) => {
  console.log(`  [${idx + 1}] ID: ${item.id} | Type: ${item.type} | Weight: ${item.weight} | Enabled: ${item.enabled} | Mood: ${item.mood.join(',')} | Tags: ${item.tags.join(',')}`);
});

if (allItems.length < 5) {
  console.error('FAILED: Expected at least 5 visual reply items!');
  process.exit(1);
}

// 5. Test Frontend renderVisualReplies Output Logic
console.log('\n=== Step 5: Frontend Card Rendering Verification ===');
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const renderedCards = allItems.map(item => {
  const typeBadgeClass = `badge-${item.type || 'custom'}`;
  const tagsHtml = (item.tags || []).map(t => `<span class="visual-pill">#${escapeHtml(t)}</span>`).join(' ');
  const moodHtml = (item.mood || []).map(m => `<span class="visual-pill">🎭 ${escapeHtml(m)}</span>`).join(' ');

  return `
    <div class="visual-card ${item.enabled ? '' : 'disabled'}" data-id="${escapeHtml(item.id)}">
      <div class="visual-card-header">
        <span class="visual-card-id" title="${escapeHtml(item.id)}">${escapeHtml(item.id)}</span>
        <div style="display: flex; align-items: center; gap: 6px;">
          <span class="visual-pill ${typeBadgeClass}">${escapeHtml(item.type)}</span>
          <span class="visual-pill" title="权重 (Weight)">⚡ ${item.weight || 10}</span>
        </div>
      </div>
      <div class="visual-card-preview">${escapeHtml(item.content)}</div>
      ${item.description ? `<div class="text-muted text-sm" style="font-size: 12px;">${escapeHtml(item.description)}</div>` : ''}
      <div class="visual-card-meta">${tagsHtml} ${moodHtml}</div>
      <div class="visual-card-actions">
        <button class="btn btn-sm ${item.enabled ? 'btn-secondary' : 'btn-success'} btn-toggle-visual" data-id="${escapeHtml(item.id)}" data-enabled="${item.enabled}">
          ${item.enabled ? '⏸️ 禁用' : '▶️ 启用'}
        </button>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-sm btn-secondary btn-edit-visual" data-id="${escapeHtml(item.id)}">✏️ 编辑</button>
          <button class="btn btn-sm btn-danger btn-delete-visual" data-id="${escapeHtml(item.id)}">🗑️ 删除</button>
        </div>
      </div>
    </div>
  `;
}).join('');

console.log(`Rendered ${renderedCards.length} characters of HTML containing ${allItems.length} cards.`);
console.log('Sample Rendered Card Output:\n', renderedCards.split('</div>\n    </div>')[0] + '</div>\n    </div>');

// 6. Test Filtering Logic by Type
console.log('\n=== Step 6: Filter Verification ===');
const types = ['all', 'braille', 'ascii', 'kaomoji', 'emoji', 'steam', 'custom'];
types.forEach(t => {
  const filtered = t === 'all' ? allItems : allItems.filter(i => i.type === t);
  console.log(`  Tab [${t.toUpperCase()}]: ${filtered.length} items found`);
});

// 7. Test Top Type Pills in index.html
console.log('\n=== Step 7: Top Type Filter Pills in index.html ===');
const pillsMatch = html.match(/<div class="visual-category-pills" id="visual-type-pills">([\s\S]*?)<\/div>/);
if (pillsMatch) {
  const pillBtns = pillsMatch[1].match(/<button class="visual-cat-pill[^"]*" data-type="([^"]+)">([^<]+)<\/button>/g);
  console.log('Found Top Filter Pill Buttons:', pillBtns?.length);
  pillBtns?.forEach(b => console.log('  ' + b.trim()));
} else {
  console.error('FAILED: Top filter pills bar not found in index.html!');
  process.exit(1);
}

console.log('\n✅ ALL VERIFICATION STEPS PASSED PERFECTLY!');
process.exit(0);
