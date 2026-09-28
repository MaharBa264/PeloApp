# Validación del primer piloto

Fecha: 28/09/2026.

## Ejecutado

`npm run check` con Node.js 24.19.0: sintaxis correcta, ocho pruebas aprobadas y bundle Excel generado.

- Dinero en centavos, actualización de precio, pagos parciales y anticipos.
- Redondeo y cancelación completa sin saldo negativo.
- API sobre SQLite real: instalación protegida, login y cookies, creación de productos/clientes/consumos, precio cambiado entre cotización y cobro, idempotencia, conflicto entre operadores, saldos consistentes, permisos por colegio, consulta sin escritura, usuarios desactivados y personalización validada.
- Rollback completo ante error en un lote de escrituras.
- Subida a almacenamiento simulado, lectura estructurada simulada, edición y descarga autenticada de foto; borrador no altera catálogo/cuentas; rechazo de formato falso, control de rol y borrado de imagen; modo manual cuando Workers AI no está enlazado.

## No verificado todavía

- Runtime real de Cloudflare Workers y D1; permisos de builds, migraciones remotas y publicación automática.
- Revisión visual con navegador: no fue posible iniciar Chromium en el entorno de trabajo. La interfaz desktop/celular y el flujo con cámara requieren una comprobación en la versión dev.
- Recurso R2 y modelo AI reales: deben probarse desde Cloudflare después de crear los buckets de dev/producción y completar el despliegue.
- Restauración de una copia de base de datos.

El despliegue inicial es para piloto con datos ficticios. Ver docs/ALCANCE.md para los pendientes antes de uso operativo.

## Ampliación 0.2.0

Se ejecutaron seis grupos de pruebas y el empaquetado del lector Excel. Se añadieron casos de importación atómica, reintentos, precios argentinos, duplicados, actualización optativa, conservación de precios de consumos, historial de precios, edición de clientes e invalidación de cotizaciones, administración de usuarios dentro de colegios asignados y rechazo de escalamiento de rol.

La lectura visual/interactiva de un Excel real en navegador queda para comprobar con un archivo del usuario en dev. La biblioteca de lectura .xlsx quedó empaquetada en la aplicación y se sirve desde el mismo dominio.

## Ampliación 0.3.0

Las ocho pruebas pasan localmente. Se agregaron migración 0003, endpoints de borrador y acceso privado a imágenes, extracción asistida por Workers AI, edición de cabecera/renglones, vínculo entre documentos y pantalla de carga/revisión mobile-first. El original no se guarda en Git ni en datos públicos.
