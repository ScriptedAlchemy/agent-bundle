import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Widget root was not found');
}

createRoot(root).render(<App />);
