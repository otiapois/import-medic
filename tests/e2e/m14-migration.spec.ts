import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFits, test } from './browser';
import { button, csv, field, openStudio, pair, parseCsv, save } from './m7-files';
import { auditPage } from './m10-accessibility';

const platforms = ['shopify', 'woocommerce', 'bigcommerce'] as const;
type Platform = typeof platforms[number];
const fixture = (source: Platform) => resolve('fixtures/catalog-migrator', source + '-canvas.csv');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const status = (page: Page) => page.getByTestId('catalog-migration-status');
const marks = (page: Page, key: string) => page.locator('code[data-custody-field="' + key + '"]');
const ready = async (page: Page) => {
  await expect(status(page)).toHaveText('Target CSV ready for review');
  await expect(status(page)).toHaveAttribute('data-ready', 'true');
  await expect(button(page, 'Target Import CSV')).toBeEnabled();
};

async function enter(page: Page, begin: () => void) {
  await openStudio(page, begin);
  const tabs = page.getByRole('tablist', { name: /studio/i });
  await expect(tabs.getByRole('tab', { name: 'Build Update' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab').nth(4)).toHaveAccessibleName('Migrate Catalog');
  await tabs.getByRole('tab', { name: 'Migrate Catalog' }).click();
}

async function direction(page: Page, source: Platform, target: Platform) {
  await field(page, 'Source platform').selectOption(source);
  const picker = field(page, 'Target platform');
  expect(await picker.locator('option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value)))
    .toEqual(platforms.filter(p => p !== source));
  await picker.selectOption(target);
}

async function shot(page: Page, info: TestInfo, anchor: Locator, name: string) {
  await assertFits(page);
  if (process.env.IMPORT_MEDIC_CAPTURE_M14_SCREENSHOTS !== '1') return;
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await anchor.evaluate(el => window.scrollBy(0, el.getBoundingClientRect().top - 18));
  const dir = process.env.IMPORT_MEDIC_M14_SCREENSHOTS || resolve('docs/reports/screenshots/m14');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: resolve(dir, info.project.name + '-m14-' + name + '.png'), animations: 'disabled' });
}

// Inspect actual imported text in each cell. Words may wrap between spaces in a table.
async function desktopCells(cells: Locator) {
  const broken = await cells.evaluateAll(elements => elements.flatMap(cell => {
    const bounds = cell.getBoundingClientRect();
    const text = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const failures: string[] = [];
    while (text.nextNode()) {
      for (const match of text.currentNode.textContent!.matchAll(/[\p{L}\p{N}]+(?:[.\-][\p{L}\p{N}]+)*/gu)) {
        const range = document.createRange();
        range.setStart(text.currentNode, match.index);
        range.setEnd(text.currentNode, match.index + match[0].length);
        const rects = Array.from(range.getClientRects()).filter(rect => rect.width);
        if (rects.length !== 1 || rects.some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1))
          failures.push(match[0]);
      }
    }
    return failures;
  }));
  expect(broken, 'Each visible header, amount, SKU and status word fits its own cell').toEqual([]);
}

async function verifyPreview(page: Page, target: Platform, info: TestInfo) {
  const panel = page.getByRole('region', { name: 'Target CSV rows' });
  await expect(panel.getByText('00123', { exact: true })).toBeVisible();
  if (info.project.name !== 'desktop') return;
  await desktopCells(panel.locator('th,td'));
  const keys = target === 'shopify' ? ['Row type','Variant SKU','Variant Price','Variant Compare At Price','Variant Inventory Qty']
    : target === 'woocommerce' ? ['Row type','SKU','Regular price','Sale price','Stock'] : ['Row type','SKU','Price','Sale Price','Current Stock'];
  const clipped = await panel.evaluate((node, important) => {
    const bounds = node.getBoundingClientRect();
    return [...node.querySelectorAll('thead th')].filter(th => important.includes(th.textContent!))
      .filter(th => th.getBoundingClientRect().left < bounds.left - 1 || th.getBoundingClientRect().right > bounds.right + 1)
      .map(th => th.textContent);
  }, keys);
  expect(clipped, 'Primary prices, stock and SKU are visible together on desktop').toEqual([]);
}

function rowsOf(text: string) {
  const [headers, ...rows] = parseCsv(text);
  expect(new Set(headers).size).toBe(headers.length);
  return rows.map(row => {
    expect(row).toHaveLength(headers.length);
    return Object.fromEntries(headers.map((header, index) => [header, row[index]]));
  });
}

function verifyNative(text: string, source: Platform, target: Platform) {
  const rows = rowsOf(text);
  const legacy = source === 'bigcommerce';
  const regular = '24.99', sale = legacy ? '' : '18.50';
  const skuKey = target === 'shopify' ? 'Variant SKU' : 'SKU';
  const [indigo, sand] = ['00123', '0045-A'].map(sku => rows.find(r => r[skuKey] === sku)!);
  expect(indigo, 'Original first sellable SKU').toBeDefined();
  expect(sand, 'Original second sellable SKU').toBeDefined();
  const pouch = rows.find(row => row[skuKey] === '0002');
  if (target === 'woocommerce') {
    expect(rows.map(row => row.Type)).toEqual(legacy ? ['variable','variation','variation','simple'] : ['variable','variation','variation']);
    expect(rows.every(row => row.ID === '')).toBe(true);
    expect(rows[0]).toMatchObject({ Name: 'Canvas Weekender', Parent: '', Published: '1', 'Visibility in catalog': 'visible',
      'Attribute 1 name': 'Color', 'Attribute 1 value(s)': 'Indigo, Sand', 'Attribute 2 name': 'Size', 'Attribute 2 value(s)': 'Carry-on' });
    expect(rows[0].SKU).toBeTruthy();
    for (const [row,color,price,onSale,stock] of [[indigo,'Indigo',regular,sale,'7'],[sand,'Sand','25.00','','0']] as const) {
      expect(row).toMatchObject({ Parent: rows[0].SKU, 'Attribute 1 name':'Color','Attribute 1 value(s)':color,
        'Attribute 2 name':'Size','Attribute 2 value(s)':'Carry-on','Regular price':price,'Sale price':onSale, Stock:stock });
    }
    if (legacy) expect(pouch).toMatchObject({Name:'Canvas Pouch','Visibility in catalog':'hidden','Regular price':'10.99','Sale price':'8.49',Stock:'3'});
  } else if (target === 'bigcommerce') {
    expect(rows.map(row => row.Item)).toEqual(['Product', 'Variant', 'Variant']);
    expect(rows[0]).toMatchObject({ ID:'', Type:'physical', Name:'Canvas Weekender', 'Is Visible':'TRUE', 'Inventory Tracking':'variant', Weight:'850' });
    for (const [row,color,price,onSale,qty,weight] of [[indigo,'Indigo',regular,sale,'7','850'],[sand,'Sand','25.00','','0','900']] as const) {
      expect(row).toMatchObject({ ID:'', Name:'', Type:'', Price:price, 'Sale Price':onSale, 'Current Stock':qty, Weight:weight });
      expect(row.Options.split(/\r?\n/)).toEqual(['Type=Dropdown|Name=Color|Value='+color,'Type=Dropdown|Name=Size|Value=Carry-on']);
    }
  } else {
    expect(rows.map(row => row[skuKey])).toEqual(legacy ? ['00123','0045-A','0002'] : ['00123','0045-A']);
    expect(indigo).toMatchObject({ Handle:'canvas-weekender',Title:'Canvas Weekender','Option1 Name':'Color','Option1 Value':'Indigo',
      'Option2 Name':'Size','Option2 Value':'Carry-on','Variant Price':sale || regular,'Variant Compare At Price':sale ? regular : '',
      'Variant Inventory Qty':'7', 'Variant Inventory Tracker':'shopify',Status:'active',Published:'TRUE' });
    expect(sand).toMatchObject({ Handle:indigo.Handle, Title:'','Option1 Name':'','Option1 Value':'Sand','Option2 Value':'Carry-on',
      'Variant Price':'25.00','Variant Compare At Price':'','Variant Inventory Qty':'0' });
    if (legacy) expect(pouch).toMatchObject({Title:'Canvas Pouch','Variant Price':'8.49','Variant Compare At Price':'10.99','Variant Inventory Qty':'3',Published:'FALSE'});
  }
}

for (const source of platforms) {
  test(source + ' upload yields both native creation files with exact variant identity, prices and stock', async ({page, beginProcessing}, info) => {
    await enter(page, beginProcessing);
    for (const target of platforms.filter(p => p !== source)) {
      await direction(page, source, target);
      await field(page, 'Choose source catalog CSV').setInputFiles(fixture(source));
      await ready(page);
      await verifyPreview(page, target, info);
      const stage = 'm14-' + source + '-to-' + target;
      const file = await save(page, info, 'Target Import CSV', 'migrated-' + source + '-to-' + target + '.csv', stage);
      verifyNative(file.text, source, target);
      const audit = JSON.parse((await save(page, info, 'Migration Audit JSON', 'migration-audit.json', stage)).text);
      const products = source === 'bigcommerce' ? 2 : 1, variants = products + 1;
      expect(audit.summary).toEqual({sourceProducts:products, sourceVariants:variants, targetProducts:products, targetVariants:variants, variantParity:true});
      const omitted = {shopify:'Custom label',woocommerce:'Purchase note',bigcommerce:'Product Description'}[source];
      expect(audit.unmappedColumns).toContain(omitted);
      expect(Object.keys(rowsOf(file.text)[0])).not.toContain(omitted);
      await expect(page.getByTestId('migration-unmapped-columns')).toContainText(omitted);
      if (source === 'shopify') expect(audit.issues).toContainEqual(expect.objectContaining({code:'omitted-image-row', line:5, column:'Image Src',level:'disclosure'}));
      if (source === 'bigcommerce') expect(audit.issues).toContainEqual(expect.objectContaining({code:'resolved-legacy-rule', line:5,level:'disclosure'}));
      info.annotations.push({type:'m14-direction',description:JSON.stringify({source,target,summary:audit.summary,sha256:digest(await readFile(file.path))})});
    }
  });
}

test('Offline sign-off and exact downloaded WooCommerce file carry custody into migration and Build Update', async ({page, beginProcessing}, info) => {
  await enter(page, beginProcessing);
  const marker = 'Agency <sample> & notes';
  const input = {name:'Canvas & Co.csv',mimeType:'text/csv',buffer:Buffer.from((await readFile(fixture('shopify'),'utf8')).replace('Custom label',marker))};
  await field(page, 'Choose source catalog CSV').setInputFiles(input);
  await ready(page);
  await expect(page.getByTestId('migration-unmapped-columns').getByText(marker, {exact:true})).toBeVisible();
  await expect(page.getByTestId('migration-issues').getByText('omitted-image-row')).toBeVisible();
  const accessibility = await auditPage(page, 'workbench');
  await shot(page, info, info.project.name === 'desktop' ? page.getByRole('heading',{name:'Migrate a product catalog'}) : status(page),
    info.project.name === 'desktop' ? 'catalog-migrator' : 'migrator');
  const stage = 'm14-interop';
  const target = await save(page,info,'Target Import CSV','migrated-shopify-to-woocommerce.csv',stage);
  verifyNative(target.text,'shopify','woocommerce');
  const audit = JSON.parse((await save(page,info,'Migration Audit JSON','migration-audit.json',stage)).text);
  const html = await save(page,info,'Migration Sign-Off (.html)','migration-sign-off.html',stage);
  await writeFile(resolve(dirname(html.path),input.name),input.buffer);
  const custody = {sourceSha256:digest(input.buffer),targetSha256:digest(await readFile(target.path)),signOffSha256:digest(await readFile(html.path))};
  expect(audit.custody).toEqual(custody);
  expect(audit.mapping).toContainEqual(expect.objectContaining({source:marker,target:null}));
  for (const [key,value] of [['source',custody.sourceSha256],['target',custody.targetSha256],['sign-off',custody.signOffSha256]])
    await expect(marks(page,key)).toHaveText(value);
  const offline = await page.context().newPage();
  await offline.goto(pathToFileURL(html.path).href);
  expect(new URL(offline.url()).protocol).toBe('file:');
  await expect(offline.getByRole('heading',{name:'Migration Sign-Off'})).toBeVisible();
  await expect(offline.getByRole('rowheader',{name:marker,exact:true})).toBeVisible();
  expect(html.text).toContain('Agency &lt;sample&gt; &amp; notes');
  const csp = await offline.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp!.split(/;\s*/)).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'none'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'"]));
  await expect(offline.locator('sample, script, iframe, form, [src], [href], [srcset], [action], [style*="url("]')).toHaveCount(0);
  expect(await offline.locator('*').evaluateAll(nodes => nodes.flatMap(node => node.getAttributeNames().filter(a => /^on/i.test(a))))).toEqual([]);
  expect(html.text).not.toMatch(/https?:\/\//i);
  await expect(offline.getByRole('table',{name:'Catalog counts'}).locator('tbody tr')).toHaveText(['Source12','Target12']);
  await expect(offline.getByText(/Verified by re-parsing the target CSV/)).toBeVisible();
  await expect(offline.locator('footer dd')).toHaveText([custody.sourceSha256,custody.targetSha256]);
  await assertFits(offline);
  if (info.project.name === 'desktop') {
    await desktopCells(offline.locator('th,td'));
    await shot(offline,info,offline.getByRole('heading',{name:'Migration Sign-Off'}),'migration-signoff');
  }
  await offline.close();
  await direction(page,'woocommerce','bigcommerce');
  await field(page, 'Choose source catalog CSV').setInputFiles(target.path);
  await ready(page);
  await expect(marks(page,'source')).toHaveText(custody.targetSha256);
  const bc = await save(page,info,'Target Import CSV','migrated-woocommerce-to-bigcommerce.csv','m14-interop-reload');
  verifyNative(bc.text,'woocommerce','bigcommerce');
  await page.getByRole('tab',{name:'Build Update'}).click();
  await button(page,'WooCommerce').click();
  await field(page,'Choose WooCommerce baseline CSV').setInputFiles(target.path);
  await expect(page.getByRole('heading',{name:'Baseline file checks'})).toBeVisible();
  await expect(page.getByText(/creation CSV has blank IDs.*fresh WooCommerce store export/i)).toBeVisible();
  await field(page,'Choose supplier price sheet').setInputFiles(csv('current-offer.csv',[['SKU','Price'],['00123','26.00'],['0045-A','27.00']]));
  for (const [sku, before, after] of [['00123', '24.99', '26.00'], ['0045-A', '25.00', '27.00']]) {
    const row = page.getByRole('row').filter({has: page.getByRole('rowheader', {name: new RegExp('^' + sku + ' variation')})});
    await expect(row.getByRole('cell', {name:before, exact:true})).toBeVisible();
    await expect(row.getByRole('cell', {name:after, exact:true})).toBeVisible();
  }
  await pair(page,'WooCommerce',false);
  const buildAudit = JSON.parse((await save(page, info, 'Download Full Diff Audit (.json)',
    'migrated-shopify-to-woocommerce-price-diff.audit.json', 'm14-interop-build')).text);
  expect(buildAudit.issues.filter((issue: {source:string}) => issue.source === 'baseline')).toEqual([
    expect.objectContaining({code:'woo-needs-destination-ids',row:1,column:'ID'}),
  ]);
  expect(buildAudit.custody.baselineSha256).toBe(custody.targetSha256);
  expect(buildAudit.custody).not.toHaveProperty('updateCsvSha256');
  expect(buildAudit.custody).not.toHaveProperty('rollbackCsvSha256');
  info.annotations.push({type:'m14-interop',description:JSON.stringify({custody,accessibility,filename:basename(target.path),reloadedBigCommerceSha256:digest(await readFile(bc.path))})});
});

test('Synthetic demo clears stale artifacts and an inverted multiline input holds only the native target', async ({page, beginProcessing}, info) => {
  await enter(page, beginProcessing);
  await button(page,'Load Synthetic Multi-Variant Demo').click();
  await ready(page);
  const previous = await marks(page,'target').innerText();
  await direction(page,'woocommerce','shopify');
  await expect(button(page,'Target Import CSV')).toBeDisabled();
  await expect(marks(page,'target')).toHaveCount(0);
  await direction(page,'shopify','woocommerce');
  const original = await readFile(fixture('shopify'),'utf8');
  const dirty = Buffer.from(original.replace('0045-A,25.00,,','0045-A,25.00,19.00,'));
  await field(page,'Choose source catalog CSV').setInputFiles({name:'inverted.csv',mimeType:'text/csv',buffer:dirty});
  await expect(status(page)).toHaveText('Target CSV held for review');
  await expect(status(page)).toHaveAttribute('data-held','true');
  await expect(button(page,'Target Import CSV')).toBeDisabled();
  await expect(marks(page,'target')).toHaveCount(0);
  await expect(page.getByText(previous,{exact:true})).toHaveCount(0);
  await expect(page.getByTestId('migration-issues').getByText('Source line 4', {exact:false})).toContainText('Variant Compare At Price');
  const audit = JSON.parse((await save(page,info,'Migration Audit JSON','migration-audit.json','m14-held')).text);
  const html = await save(page,info,'Migration Sign-Off (.html)','migration-sign-off.html','m14-held');
  expect(audit.custody).toEqual({sourceSha256:digest(dirty),signOffSha256:digest(await readFile(html.path))});
  expect(audit.filenames.targetCsv).toBeNull();
  expect(audit.issues).toContainEqual(expect.objectContaining({code:'inverted-price',line:4,column:'Variant Compare At Price',level:'blocked'}));
  expect(html.text).not.toContain(previous);
});
