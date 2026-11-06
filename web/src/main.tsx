import { render } from 'preact';
import { App } from './app';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';

// Installable, and starts from cache when offline. Updates apply on the next open.
registerSW({ immediate: true });

render(<App />, document.getElementById('app')!);
