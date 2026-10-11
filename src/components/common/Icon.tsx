import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { icons, type IconName } from './icons';

interface IconProps {
  name: IconName;
  className?: string;
  spin?: boolean;
  size?: 'xs' | 'sm' | 'lg' | 'xl';
}

export default function Icon({ name, className, spin, size }: IconProps) {
  return <FontAwesomeIcon icon={icons[name]} className={`pointer-events-none ${className}`} spin={spin} size={size} />;
}
