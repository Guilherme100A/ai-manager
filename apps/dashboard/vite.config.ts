import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// O dashboard chama a API por caminhos relativos (/api, /metrics, /health). Em dev/preview, o Vite faz proxy
// para VITE_API_URL (default http://localhost:3000); em produção, sirva o dist/ na mesma origem da API.
const target = process.env.VITE_API_URL ?? 'http://localhost:3000'
// Integração CRM (página #/crm): o CRM web roda com base `/crm/` na porta CRM_WEB_PORT (default 5274) e cuida do
// próprio `/crm/api` (o proxy dele tira o prefixo `/crm` antes da API do CRM). `ws` leva o HMR do CRM junto.
const crmTarget = `http://127.0.0.1:${process.env.CRM_WEB_PORT ?? '5274'}`
const proxy = {
  '/api': target,
  '/metrics': target,
  '/health': target,
  '/crm': { target: crmTarget, changeOrigin: true, ws: true },
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Consome o código-fonte dos pacotes @wsm/* (export condition "development") também no build.
    conditions: ['development'],
  },
  server: { port: 5173, proxy },
  preview: { proxy },
})
