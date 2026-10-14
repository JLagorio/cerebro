// The state lab's entry (M64.1), loaded only by state-lab.html under pnpm dev.
import '@/styles/index.css';
import { mountStateLab } from './StateLab';

mountStateLab(document.getElementById('root'), import.meta.env.DEV);
