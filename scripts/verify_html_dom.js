const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.resolve(__dirname, '../release/dist/ui/index.html'), 'utf8');
const js = fs.readFileSync(path.resolve(__dirname, '../release/dist/ui/app.js'), 'utf8');

console.log('=== 1. JS SYNTAX CHECK ===');
try {
  new vm.Script(js);
  console.log('JS Syntax: OK (Zero parse errors)');
} catch (e) {
  console.error('JS Syntax Error:', e);
}

console.log('\n=== 2. HTML HIERARCHY CHECK ===');
const logsIdx = html.indexOf('id="view-logs"');
const visualIdx = html.indexOf('id="view-visual-replies"');
const firstSectionCloseAfterLogs = html.indexOf('</section>', logsIdx);
const secondSectionCloseAfterLogs = html.indexOf('</section>', firstSectionCloseAfterLogs + 10);

console.log('Position of id="view-logs":', logsIdx);
console.log('Position of id="view-visual-replies":', visualIdx);
console.log('Position of first </section> after view-logs:', firstSectionCloseAfterLogs);
console.log('Position of second </section> after view-logs:', secondSectionCloseAfterLogs);

if (firstSectionCloseAfterLogs > visualIdx) {
  console.log('\n🚨 CRITICAL FINDING:');
  console.log('`#view-visual-replies` is located at index ' + visualIdx);
  console.log('but the first `</section>` after `#view-logs` is at index ' + firstSectionCloseAfterLogs);
  console.log('This proves `<section id="view-visual-replies">` was opened INSIDE `<section id="view-logs">` before `#view-logs` was ever closed!');
  console.log('In CSS:');
  console.log('.view-panel { display: none; }');
  console.log('.view-panel.active { display: block; }');
  console.log('When switching to "visual-replies":');
  console.log('- #view-logs loses "active" class => display: none');
  console.log('- Since #view-visual-replies is a child of #view-logs, it is inside an element with display: none!');
  console.log('- In DOM rendering, NO descendant of a display:none element can ever be visible!');
  console.log('=> RESULT: Entire main content area is 100% BLANK!');
} else {
  console.log('Sections are separate siblings.');
}

console.log('\n=== 3. SECTION TAG AUDIT IN index.html ===');
// Count opening <section> and closing </section>
const openSections = (html.match(/<section\b/gi) || []).length;
const closeSections = (html.match(/<\/section>/gi) || []).length;
console.log(`Opening <section> tags: ${openSections}`);
console.log(`Closing </section> tags: ${closeSections}`);
if (openSections !== closeSections) {
  console.log(`🚨 MISMATCH: Found ${openSections} opening <section> tags but only ${closeSections} closing </section> tags!`);
} else {
  console.log('Section tag counts match.');
}
