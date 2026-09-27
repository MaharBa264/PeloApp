# Validación del primer piloto

Fecha: 27/09/2026.

## Ejecutado

`npm run check` con Node.js 24.19.0: sintaxis correcta y cuatro grupos de pruebas aprobados.

- Dinero en centavos, actualización de precio, pagos parciales y anticipos.
- Redondeo y cancelación completa sin saldo negativo.
- API sobre SQLite real: instalación protegida, login y cookies, creación de productos/clientes/consumos, precio cambiado entre cotización y cobro, idempotencia, conflicto entre operadores, saldos consistentes, permisos por colegio, consulta sin escritura, usuarios desactivados y personalización validada.
- Rollback completo ante error en un lote de escrituras.

## No verificado todavía

- Runtime real de Cloudflare Workers y D1; permisos de builds, migraciones remotas y publicación automática.
- Revisión visual con navegador: se preparó un recorrido de UI, pero la descarga de Chromium en el entorno de trabajo falló. No se declara aprobada la UI de escritorio/celular hasta probar la versión dev.
- Restauración de una copia de base de datos.

El despliegue inicial es para piloto con datos ficticios. Ver docs/ALCANCE.md para los pendientes antes de uso operativo.
