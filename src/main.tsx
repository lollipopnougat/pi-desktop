import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
// highlight.js 样式表：由 index.html 里两个 <link data-hljs> 按主题切换，这里不再静态 import
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
