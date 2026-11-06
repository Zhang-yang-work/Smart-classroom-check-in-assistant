const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const { createClient } = require('@supabase/supabase-js');

function loadSource(path, dependencies, globals = {}) {
  const source = readFileSync(join(__dirname, '../..', path), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
    },
  });
  const exports = {};
  runInNewContext(outputText, {
    exports,
    URL,
    require(id) {
      assert.ok(Object.hasOwn(dependencies, id), `Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    ...globals,
  });
  return exports;
}

test('认证和上传只记录元数据，并保留请求参数、返回值和错误', async () => {
  const logs = [];
  const received = [];
  const authResponse = { token: 'response-secret', user: { id: 'test-user' } };
  const roster = [{ binding_code: 'roster-secret' }];
  let statusCode = 200;
  const api = loadSource('src/api/index.ts', {
    '@tarojs/taro': {},
    '@/utils/storage': { getToken: () => 'bearer-secret' },
    '@/network': {
      Network: {
        request: async (request) => {
          received.push(request);
          return { statusCode, data: { msg: '认证失败', data: authResponse } };
        },
        uploadFile: async (request) => {
          received.push(request);
          return { statusCode, data: JSON.stringify({ code: 0, msg: '上传失败', data: roster }) };
        },
      },
    },
  }, { console: { log: (...args) => logs.push(args) } });
  const credentials = { name: 'name-secret', employee_no: 'teacher-no', activation_code: 'teacher-secret' };
  assert.equal(await api.activateTeacher('binding-secret', credentials), authResponse);
  await api.bindStudent('binding-secret', { student_no: '1', name: 'name-secret' });
  await api.wechatLogin('wechat-secret');
  assert.equal(JSON.stringify(await api.importRosterExcel('course-a', 'file-secret')), JSON.stringify(roster));
  assert.equal(received[0].data, credentials);
  assert.equal(received[3].filePath, 'file-secret');
  assert.equal(received[0].header.Authorization, 'Bearer binding-secret');
  assert.equal(received[2].header.Authorization, undefined);
  assert.equal(received[3].header.Authorization, 'Bearer bearer-secret');
  statusCode = 400;
  await assert.rejects(api.activateTeacher('binding-secret', credentials), /认证失败/);
  await assert.rejects(api.importRosterExcel('course-a', 'file-secret'), /上传失败/);
  const output = JSON.stringify(logs);
  assert.match(output, /\/api\/auth\/teacher\/activate/);
  assert.match(output, /"statusCode":400/);
  assert.doesNotMatch(output, /secret|Authorization|Bearer|teacher_code|binding_code/);
});

test('种子初始化仅允许明确启用且指向本机隔离测试库', async () => {
  const local = {
    NODE_ENV: 'test',
    ENABLE_DEMO_SEED: 'true',
    COZE_SUPABASE_URL: 'http://127.0.0.1:54321',
    COZE_SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key',
    DEMO_SEED_TEACHER_CODE: 'synthetic-test-fixture-credential-only',
  };
  const logs = [];
  let calls = 0;
  const process = { env: {} };
  const { SeedService } = loadSource('server/src/seed/seed.service.ts', {
    '@nestjs/common': {
      Injectable: () => (type) => type,
      Logger: class { warn(message) { logs.push(message); } },
    },
    '@/storage/database/supabase-client': {
      getSupabaseClient() {
        calls++;
        throw new Error('synthetic-key');
      },
    },
  }, { process });
  for (const env of [
    {},
    { ...local, ENABLE_DEMO_SEED: '' },
    { ...local, NODE_ENV: 'development' },
    { ...local, NODE_ENV: 'production' },
    { ...local, COZE_SUPABASE_URL: 'https://shared.test' },
    { ...local, COZE_SUPABASE_URL: 'http://127.0.0.1@shared.test' },
    { ...local, COZE_SUPABASE_SERVICE_ROLE_KEY: '' },
    { ...local, DEMO_SEED_TEACHER_CODE: 'short' },
  ]) {
    process.env = env;
    await new SeedService().onModuleInit();
  }
  assert.equal(calls, 0);
  process.env = local;
  await new SeedService().onModuleInit();
  assert.equal(calls, 1);
  assert.doesNotMatch(logs.join(' '), /synthetic-key|fixture-credential/);
});

test('管理员客户端拒绝 anon 回退并保留合法管理员和显式用户客户端', () => {
  const env = {
    COZE_SUPABASE_URL: 'https://database.test',
    COZE_SUPABASE_ANON_KEY: 'synthetic-anon',
    COZE_SUPABASE_SERVICE_ROLE_KEY: ' ',
  };
  const { getSupabaseClient } = loadSource('server/src/storage/database/supabase-client.ts', {
    '@supabase/supabase-js': { createClient },
    dotenv: { config() {} },
    child_process: { execSync: () => '' },
  }, { process: { env } });
  assert.throws(() => getSupabaseClient(), /^Error: COZE_SUPABASE_SERVICE_ROLE_KEY is not set$/);
  const scoped = getSupabaseClient('synthetic-user');
  assert.equal(scoped.supabaseKey, 'synthetic-anon');
  assert.equal(scoped.headers.Authorization, 'Bearer synthetic-user');
  delete env.COZE_SUPABASE_ANON_KEY;
  env.COZE_SUPABASE_SERVICE_ROLE_KEY = 'synthetic-admin';
  const admin = getSupabaseClient();
  assert.equal(admin.supabaseKey, 'synthetic-admin');
  assert.equal(admin.supabaseUrl, 'https://database.test');
});
