# PeloApp

Cuentas corrientes para tres kioscos escolares. Interfaz luminosa adaptable a celular y PC. Primera versión **0.1.0 de piloto**, con comparación de precios al adquirir y al pagar, anticipos y permisos por colegio.

## Estado

Código y configuración preparados para Cloudflare Workers + D1. La conexión del repositorio a Cloudflare, las migraciones remotas y la publicación deben verificarse en la cuenta del propietario. No hay datos ni credenciales reales en este repositorio.

- [Configurar Cloudflare y crear el primer superadministrador](docs/CLOUDFLARE.md)
- [Alcance implementado, reglas monetarias y pendientes](docs/ALCANCE.md)

## Desarrollo

Node.js 24 o superior. La interfaz y el Worker usan módulos JavaScript nativos sin dependencias de ejecución; no requieren un bundler de frontend. Wrangler se ejecuta con npx. Esta elección mantiene pequeña y verificable la primera versión, con la API separada de la interfaz para futuras apps.

```sh
npm run check
npm run db:local
npm run dev
```

Crear `.dev.vars.dev` local con `BOOTSTRAP_TOKEN` para la instalación de desarrollo. Este archivo está excluido de Git. El navegador local debe soportar cookies Secure en localhost; producción usa HTTPS.

## Pruebas

`npm run check` valida sintaxis y ejecuta pruebas del dominio y la API sobre SQLite real mediante un adaptador de D1. Incluye precio actualizado, cobro parcial, anticipos, rollback, aislamiento por colegio, roles, origen de solicitudes e idempotencia. Aún debe validarse en D1 real.

## Ramas y datos

- `main`: Worker `peloapp`, D1 `PeloApp-prod`.
- `dev`: Worker `peloapp-dev`, D1 `PeloApp-dev`.

No guardar respaldos ni datos personales en este repositorio público.
