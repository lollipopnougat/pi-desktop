import { useState } from 'react';
import Icon from './Icon';

interface PasswordInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** 输入框右侧是否显示眼睛切换按钮，默认 true */
  showToggle?: boolean;
}

/**
 * 密码输入框：默认以密文显示，右侧带眼睛图标按钮，
 * 点击切换明文/密文显示。
 */
export default function PasswordInput({
  showToggle = true,
  className = '',
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative flex-1">
      <input type={visible ? 'text' : 'password'} className={className} {...props} />
      {showToggle && (
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-od-text-dim hover:text-od-text-bright"
          tabIndex={-1}
          title={visible ? '隐藏' : '显示'}
        >
          <Icon name={visible ? 'eyeSlash' : 'eye'} className="w-3.5" />
        </button>
      )}
    </div>
  );
}
