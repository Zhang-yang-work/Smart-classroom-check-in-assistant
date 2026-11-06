export default defineAppConfig({
  pages: [
    'pages/index/index',
    'pages/student/index',
    'pages/teacher/index',
    'pages/course/index',
    'pages/detail/index',
    'pages/ai/index'
  ],
  permission: {
    'scope.userLocation': { desc: '用于位置签到和设置签到中心' }
  },
  requiredPrivateInfos: ['getLocation'],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: '智能课堂签到助手',
    navigationBarTextStyle: 'black'
  }
})
