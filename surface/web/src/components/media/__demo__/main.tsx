import { createRoot } from 'react-dom/client';
import '../../../index.css';
import { ThemeProvider } from '../../../theme';
import { MediaDemo } from './Demo';

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <MediaDemo />
  </ThemeProvider>,
);
