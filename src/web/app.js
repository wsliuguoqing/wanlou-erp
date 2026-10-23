/* 启动入口 */
'use strict';

(async function boot() {
  // 恢复会话
  if (App.token) {
    try {
      await loadMe();
      render();
      return;
    } catch (e) {
      App.token = '';
      localStorage.removeItem('wl_token');
    }
  }
  render();
})();

// 全局键盘：Esc 关闭弹窗
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDialog();
});

// 全局错误提示
window.addEventListener('error', (e) => {
  if (e.message && !/Script error/.test(e.message)) console.error(e.message);
});
