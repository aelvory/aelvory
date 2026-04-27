import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import ConfirmationService from 'primevue/confirmationservice';
import ToastService from 'primevue/toastservice';
import Aura from '@primevue/themes/aura';
import 'primeicons/primeicons.css';

import App from './App.vue';
import { router } from './router';
import { i18n } from './i18n';

const app = createApp(App);
app.use(createPinia());
app.use(i18n);
app.use(router);
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.dark',
      cssLayer: false,
    },
  },
});
app.use(ConfirmationService);
app.use(ToastService);

app.mount('#app');
