import type { ImageSourcePropType } from 'react-native';

import type { FaceKey } from '../types';

/** Staff faces exported from the prototype media.js (VT_FACES_M / VT_FACES_W). */
export const FACES: Record<FaceKey, ImageSourcePropType> = {
  m0: require('../../../assets/faces/m0.jpg'),
  m1: require('../../../assets/faces/m1.jpg'),
  m2: require('../../../assets/faces/m2.jpg'),
  m4: require('../../../assets/faces/m4.jpg'),
  m6: require('../../../assets/faces/m6.jpg'),
  w0: require('../../../assets/faces/w0.jpg'),
};
