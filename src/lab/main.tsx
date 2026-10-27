// The state lab's entry (M64.1), loaded only by state-lab.html under pnpm dev.
import '@/styles/index.css';
import { mountStateLab } from './StateLab';
import { mountCompositionLab } from './CompositionLab';

if (new URLSearchParams(window.location.search).has('composition')) {
  mountCompositionLab(document.getElementById('root'), import.meta.env.DEV);
} else {
  mountStateLab(document.getElementById('root'), import.meta.env.DEV);
}
