import 'lucide-react-native';
import type { ColorValue, StyleProp, ViewStyle } from 'react-native';

declare module 'lucide-react-native' {
  interface LucideProps {
    color?: ColorValue;
    stroke?: ColorValue;
    style?: StyleProp<ViewStyle>;
  }
}
