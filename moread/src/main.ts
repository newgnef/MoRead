import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');
if (!target) throw new Error('#app 容器缺失');

export default mount(App, { target });
