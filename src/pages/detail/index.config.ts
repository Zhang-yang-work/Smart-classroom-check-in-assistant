export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '签到详情' })
  : { navigationBarTitleText: '签到详情' }