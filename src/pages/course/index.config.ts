export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '课程与名单' })
  : { navigationBarTitleText: '课程与名单' }