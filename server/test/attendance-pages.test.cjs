const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

function pageHarness(page, environment, api, locate = async () => {}) {
  const state = [];
  const hooks = {};
  let cursor = 0;
  const components = new Proxy({}, { get: (_, name) => name });
  const taro = { getEnv: () => environment, ENV_TYPE: { WEAPP: 'WEAPP' },
    getLocation: () => { throw new Error('Unexpected direct geolocation'); }, showToast() {} };
  const dependencies = {
    react: { useState(initial) {
      const index = cursor++;
      if (!(index in state)) state[index] = initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    } },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' },
    '@tarojs/taro': { default: taro,
      useDidShow: callback => { hooks.show = callback; }, useDidHide() {},
      useLoad: callback => { hooks.load = callback; } },
    '@/api': api, '@/utils/attendance-proof': { currentLocation: locate },
    '@/utils/format': { statusText: status => status, modeText: mode => mode, formatDateTime: () => 'test time' },
    './qr-display': { QrDisplay: 'QrDisplay' },
  };
  const source = readFileSync(join(__dirname, '../../src/pages', page, 'index.tsx'), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX,
  } });
  const exports = {};
  runInNewContext(outputText, { exports, Math, require(name) {
    if (name.startsWith('@/components/ui/') || ['@tarojs/components','lucide-react-taro'].includes(name)) return components;
    assert.ok(Object.hasOwn(dependencies, name), 'Unexpected page dependency '+name);
    return dependencies[name];
  } });
  let tree;
  const nodes = value => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object') return [];
    return [value, ...nodes(value.props?.children)];
  };
  const text = value => {
    if (Array.isArray(value)) return value.map(text).join('');
    return value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  };
  const render = () => { cursor=0; tree=exports.default(); return tree; };
  render();
  return { hooks, render, text: () => text(tree),
    find: (type, label) => nodes(tree).find(node => node.type===type && (label===undefined || text(node)===label)),
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('详情页面四态调整在空原因下均可点击保存且不补造文本', async () => {
  const calls = [];
  const detail = { task: { id: 'task', status: 'ended', mode: 'normal' },
    participants: [{ student_no: '001', student_name: '测试', status: 'present' }] };
  const page = pageHarness('detail', 'WEAPP', {
    getTaskDetail: async () => detail,
    adjustAttendance: async (id, data) => { calls.push({id, ...data}); },
  });
  page.hooks.load({id:'task'});
  await flush();
  for (const status of ['present','late','excused','absent']) {
    page.render();
    page.find('Button','调整').props.onClick();
    page.render();
    page.find('Button',status).props.onClick();
    page.render();
    const save = page.find('Button','保存调整');
    assert.equal(save.props.disabled,false);
    await save.props.onClick();
    assert.equal(calls.at(-1).reason,'');
    assert.equal(calls.at(-1).status,status);
    assert.match(page.text(),/选填|保存调整/);
  }
});

test('WebView 页面显示环境说明和真实建筑选项，发送预设且不调用定位', async () => {
  let locations=0;
  const calls=[];
  const page = pageHarness('ai','H5',{
    listLocationPresets: async () => [{id:'library',name:'图书馆'}],
    agentChat: async (...args) => {calls.push(args);return {type:'reply',content:'测试'};},
  },async()=>{locations++;});
  page.hooks.show();
  await flush();
  page.render();
  assert.match(page.text(),/WebView\/H5.*预设建筑/);
  assert.equal(page.find('Button','附带当前位置'),undefined);
  assert.equal(page.find('SelectItem','图书馆').props.value,'library');
  page.find('Select').props.onValueChange('library');
  page.find('Textarea').props.onInput({detail:{value:'发布位置签到'}});
  page.render();
  await page.find('Button').props.onClick();
  assert.equal(locations,0);
  assert.equal(calls[0][2].location_supported,false);
  assert.equal(calls[0][2].location_preset_id,'library');
  assert.equal(calls[0][1],undefined);
});

test('原生小程序有定位入口，定位成功显示状态且可以重新定位', async () => {
  let calls=0;
  const page=pageHarness('ai','WEAPP',{ listLocationPresets:async()=>[] },async()=>{
    calls++;
    return {latitude:31,longitude:121,accuracy:10,captured_at_ms:Date.now()};
  });
  await page.find('Button','附带当前位置').props.onClick();
  page.render();
  assert.match(page.text(),/定位成功.*10 米/);
  await page.find('Button','重新定位').props.onClick();
  assert.equal(calls,2);
  page.render();
  assert.ok(page.find('Button','重新定位'));
});
