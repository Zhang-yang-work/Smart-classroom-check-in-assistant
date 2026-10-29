export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '智能课堂签到助手' })
  : { navigationBarTitleText: '智能课堂签到助手' }