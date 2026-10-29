export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '我的签到' })
  : { navigationBarTitleText: '我的签到' }