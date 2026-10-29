export default typeof definePageConfig === 'function'
  ? definePageConfig({ navigationBarTitleText: '教师工作台' })
  : { navigationBarTitleText: '教师工作台' }