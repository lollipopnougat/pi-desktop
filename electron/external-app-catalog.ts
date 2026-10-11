/** 检测、图标读取、启动共用的应用清单，安装路径不接受 renderer 传入。 */
export interface ExternalAppDefinition {
  id: string;
  name: string;
  mac?: { names: string[]; bundleIds: string[] };
  windows?: {
    /** 相对于 Program Files / 本地 Programs 的安装路径。 */
    paths?: string[];
    /** JetBrains 版本目录和 Toolbox 产品目录。 */
    directoryPattern?: RegExp;
    executable?: string;
    visualStudio?: boolean;
  };
  linux?: { commands: string[]; icons?: string[]; bundledIcon?: string };
}

export const EXTERNAL_APP_CATALOG: ExternalAppDefinition[] = [
  {
    id: 'vscode',
    name: 'VS Code',
    mac: { names: ['Visual Studio Code.app'], bundleIds: ['com.microsoft.VSCode'] },
    windows: { paths: ['Microsoft VS Code/Code.exe'] },
    linux: {
      commands: ['code'],
      icons: [
        '/usr/share/code/resources/app/resources/linux/code.png',
        '/usr/share/pixmaps/com.visualstudio.code.png',
        '/snap/code/current/meta/gui/vscode.png'
      ]
    }
  },
  {
    id: 'vscode-insiders',
    name: 'VS Code Insiders',
    mac: {
      names: ['Visual Studio Code - Insiders.app'],
      bundleIds: ['com.microsoft.VSCodeInsiders']
    },
    windows: { paths: ['Microsoft VS Code Insiders/Code - Insiders.exe'] },
    linux: {
      commands: ['code-insiders'],
      icons: ['/usr/share/code-insiders/resources/app/resources/linux/code.png']
    }
  },
  {
    id: 'idea',
    name: 'IntelliJ IDEA',
    mac: { names: ['IntelliJ IDEA.app'], bundleIds: ['com.jetbrains.intellij'] },
    windows: {
      directoryPattern:
        /^(?:IntelliJ IDEA(?! Community| CE)|IDEA-U(?:$|\W)|IntelliJ IDEA Ultimate)/i,
      executable: 'idea64.exe'
    },
    linux: { commands: ['idea', 'intellij-idea', 'intellij-idea-ultimate'], bundledIcon: 'idea' }
  },
  {
    id: 'idea-ce',
    name: 'IntelliJ IDEA CE',
    mac: {
      names: ['IntelliJ IDEA CE.app', 'IntelliJ IDEA Community Edition.app'],
      bundleIds: ['com.jetbrains.intellij.ce']
    },
    windows: {
      directoryPattern: /^(?:IntelliJ IDEA (?:Community|CE)|IDEA-C(?:$|\W))/i,
      executable: 'idea64.exe'
    },
    linux: { commands: ['idea-community', 'intellij-idea-community'], bundledIcon: 'idea' }
  },
  {
    id: 'visualstudio',
    name: 'Visual Studio',
    mac: { names: ['Visual Studio.app'], bundleIds: ['com.microsoft.visual-studio'] },
    windows: { visualStudio: true }
  },
  {
    id: 'cursor',
    name: 'Cursor',
    mac: { names: ['Cursor.app'], bundleIds: ['com.todesktop.230313mzl4w4u92'] },
    windows: { paths: ['cursor/Cursor.exe', 'Cursor/Cursor.exe'] },
    linux: {
      commands: ['cursor'],
      icons: [
        '/opt/Cursor/resources/app/resources/linux/code.png',
        '/opt/cursor/resources/app/resources/linux/code.png'
      ]
    }
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    mac: { names: ['Windsurf.app'], bundleIds: ['com.exafunction.windsurf'] },
    windows: { paths: ['Windsurf/Windsurf.exe'] },
    linux: {
      commands: ['windsurf'],
      icons: ['/usr/share/windsurf/resources/app/resources/linux/code.png']
    }
  },
  {
    id: 'webstorm',
    name: 'WebStorm',
    mac: { names: ['WebStorm.app'], bundleIds: ['com.jetbrains.WebStorm'] },
    windows: { directoryPattern: /^WebStorm(?:$|\W)/i, executable: 'webstorm64.exe' },
    linux: { commands: ['webstorm'], bundledIcon: 'webstorm' }
  },
  {
    id: 'pycharm',
    name: 'PyCharm',
    mac: { names: ['PyCharm.app'], bundleIds: ['com.jetbrains.pycharm'] },
    windows: { directoryPattern: /^PyCharm(?! Community| CE|-C)/i, executable: 'pycharm64.exe' },
    linux: { commands: ['pycharm', 'pycharm-professional'], bundledIcon: 'pycharm' }
  },
  {
    id: 'pycharm-ce',
    name: 'PyCharm CE',
    mac: { names: ['PyCharm CE.app'], bundleIds: ['com.jetbrains.pycharm.ce'] },
    windows: {
      directoryPattern: /^(?:PyCharm (?:Community|CE)|PyCharm-C(?:$|\W))/i,
      executable: 'pycharm64.exe'
    },
    linux: { commands: ['pycharm-community'], bundledIcon: 'pycharm' }
  },
  {
    id: 'phpstorm',
    name: 'PhpStorm',
    mac: { names: ['PhpStorm.app'], bundleIds: ['com.jetbrains.PhpStorm'] },
    windows: { directoryPattern: /^PhpStorm(?:$|\W)/i, executable: 'phpstorm64.exe' },
    linux: { commands: ['phpstorm'], bundledIcon: 'phpstorm' }
  },
  {
    id: 'goland',
    name: 'GoLand',
    mac: { names: ['GoLand.app'], bundleIds: ['com.jetbrains.goland'] },
    windows: { directoryPattern: /^GoLand(?:$|\W)/i, executable: 'goland64.exe' },
    linux: { commands: ['goland'], bundledIcon: 'goland' }
  },
  {
    id: 'clion',
    name: 'CLion',
    mac: { names: ['CLion.app'], bundleIds: ['com.jetbrains.CLion'] },
    windows: { directoryPattern: /^CLion(?:$|\W)/i, executable: 'clion64.exe' },
    linux: { commands: ['clion'], bundledIcon: 'clion' }
  },
  {
    id: 'rider',
    name: 'Rider',
    mac: { names: ['Rider.app', 'JetBrains Rider.app'], bundleIds: ['com.jetbrains.rider'] },
    windows: { directoryPattern: /^(?:JetBrains )?Rider(?:$|\W)/i, executable: 'rider64.exe' },
    linux: { commands: ['rider'], bundledIcon: 'rider' }
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    mac: { names: ['Sublime Text.app'], bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'] },
    windows: { paths: ['Sublime Text/sublime_text.exe', 'Sublime Text 3/sublime_text.exe'] },
    linux: {
      commands: ['subl', 'sublime_text'],
      icons: ['/opt/sublime_text/Icon/48x48/sublime-text.png']
    }
  },
  {
    id: 'zed',
    name: 'Zed',
    mac: { names: ['Zed.app'], bundleIds: ['dev.zed.Zed'] },
    windows: { paths: ['Zed/zed.exe', 'Zed/bin/zed.exe'] },
    linux: {
      commands: ['zed', 'zeditor'],
      icons: ['/usr/share/icons/hicolor/512x512/apps/zed.png']
    }
  },
  {
    id: 'notepadpp',
    name: 'Notepad++',
    windows: { paths: ['Notepad++/notepad++.exe'] }
  },
  {
    id: 'androidstudio',
    name: 'Android Studio',
    mac: { names: ['Android Studio.app'], bundleIds: ['com.google.android.studio'] },
    windows: {
      paths: ['Android/Android Studio/bin/studio64.exe'],
      directoryPattern: /^AndroidStudio(?:$|\W)/i,
      executable: 'studio64.exe'
    },
    linux: {
      commands: ['android-studio', 'studio'],
      icons: ['/opt/android-studio/bin/studio.png'],
      bundledIcon: 'studio'
    }
  },
  {
    id: 'xcode',
    name: 'Xcode',
    mac: { names: ['Xcode.app'], bundleIds: ['com.apple.dt.Xcode'] }
  },
  {
    id: 'terminal',
    name: 'Terminal',
    mac: { names: ['Utilities/Terminal.app'], bundleIds: ['com.apple.Terminal'] }
  },
  {
    id: 'iterm',
    name: 'iTerm2',
    mac: { names: ['iTerm.app'], bundleIds: ['com.googlecode.iterm2'] }
  }
];
