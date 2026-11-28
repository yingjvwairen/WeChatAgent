export const DSH_SDK_VERSION = '0.2.0-rc.2';
export const DSH_VERIFIED_DESKTOP_VERSION = '0.2.2-rc.5';
export const DSH_INSTALL_URL = 'https://www.deepseek.com/harness/';

export function dshInstallCard({ header, field, pluginPathField }) {
  return `<section class="card setup-dsh-card">${header('安装并连接 DSH', '请单独安装 DSH。', '', 'plug')}<p class="modal-description">从官网安装 DSH 并登录模型账号。已验证的桌面版本为 ${DSH_VERIFIED_DESKTOP_VERSION}，桥接插件随包 SDK 为 ${DSH_SDK_VERSION}。</p><div class="button-row"><a class="button" href="${DSH_INSTALL_URL}" target="_blank" rel="noopener noreferrer">下载安装 DSH</a></div><div class="space-top">${field('DSH 程序位置', 'runtime.dshDesktop', { full: true, browse: 'exe', placeholder: '选择已安装的 DeepSeek Harness.exe', help: '选择后先保存设置，再点击“打开 DSH”。' })}</div><p class="modal-description space-top">在 DSH 插件页面添加下方本机插件目录并启用，再从托盘完整退出并重新打开 DSH。</p>${pluginPathField()}<div class="button-row space-top"><button class="button" data-action="dsh-open">打开 DSH</button><button class="button" id="open-plugin-folder">打开插件目录</button></div></section>`;
}
