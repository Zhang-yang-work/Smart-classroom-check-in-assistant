export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: 'AI 签到助手' })
  : { navigationBarTitleText: 'AI 签到助手' }