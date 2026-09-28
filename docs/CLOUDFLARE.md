# Publicación en Cloudflare

## Recursos ya identificados

| Entorno | Worker | Base D1 | Database ID |
| --- | --- | --- | --- |
| Producción | peloapp | PeloApp-prod | a2aacc00-64ad-43c4-b6d1-607d49cabb6b |
| Pruebas | peloapp-dev | PeloApp-dev | 61010828-6e12-430a-b00a-d01fc0c4c2bc |

Los IDs no son credenciales. El binding de la aplicación se llama `DB`. Ambas bases pertenecen a la cuenta Cloudflare del propietario; este repositorio no demuestra que ya se hayan aplicado migraciones ni publicado Workers.

## Almacenamiento de fotos de documentos

Antes del siguiente despliegue, crear dos buckets desde Cloudflare → R2 Object Storage → **Create bucket**:

- `peloapp-documents-dev`
- `peloapp-documents-prod`

Dejarlos privados: no habilitar acceso público ni dominio personalizado. `wrangler.jsonc` los enlaza al Worker correspondiente. El Worker verifica sesión y rol antes de guardar o mostrar una imagen. La binding de Workers AI `AI` no usa un token; el código invoca `@cf/moondream/moondream3.1-9B-A2B` para leer una propuesta desde la foto.

Workers AI tiene una cuota gratuita diaria; al agotarse, la app igual guarda el documento como borrador manual para que se complete sin OCR. Revisar la cuota y las condiciones vigentes en Cloudflare antes de cargar documentos reales.

## Primero: entorno de pruebas

Cloudflare → Workers & Pages → Create application → Import a repository → MaharBa264/PeloApp.

- Nombre Worker: `peloapp-dev`.
- Rama: `dev`.
- Directorio raíz: `/`.
- Build command: `npm run check`.
- Deploy command: `npm run deploy:dev`.
- Node.js: 24 (variable de build `NODE_VERSION=24` si hace falta).

Cloudflare debe instalar dependencias con `npm ci` (usa el package-lock del repositorio). Los comandos de build y deploy no cambian en esta actualización.

El comando verifica el proyecto, aplica migraciones **a PeloApp-dev** y despliega `--env dev`. No agrega credenciales al repositorio. La identidad de build de Cloudflare necesita permisos de edición de Workers y D1 para aplicar migraciones; si la migración devuelve autorización denegada, revisar el token de build del proyecto en Cloudflare. No pegar tokens en issues o archivos.

## Crear el superadministrador

En el Worker de pruebas: Settings → Variables and Secrets → Add.

- Tipo: Secret.
- Nombre: `BOOTSTRAP_TOKEN`.
- Valor: una cadena aleatoria de al menos 32 caracteres, generada por tu gestor de contraseñas.

Publicar/aplicar el cambio. Abrir la URL `workers.dev` del Worker. El formulario de primera instalación pide ese secreto, nombre, correo y contraseña de 12 caracteres como mínimo. No hay usuario ni contraseña de demostración. Una vez creado el superadministrador, el endpoint de instalación queda bloqueado por la existencia de usuarios. Retirar el secreto después de instalar (si luego se restaura una base vacía se debe configurar otra vez).

El correo es el identificador de acceso, no se envían emails. Guardar la contraseña en un gestor: todavía no existe recuperación por correo.

## Producción

Crear una segunda aplicación importando el mismo repositorio:

- Nombre Worker: `peloapp`.
- Rama de producción: `main`.
- Directorio raíz: `/`.
- Build command: `npm run check`.
- Deploy command: `npm run deploy`.
- Node.js: 24.

Desactivar los despliegues de ramas de vista previa en este Worker: no deben compartir D1 de producción. Usar el Worker `peloapp-dev` para pruebas. Configurar un `BOOTSTRAP_TOKEN` diferente y crear el acceso de producción de manera independiente.

Cada push a main ejecuta los controles antes de migrar y publicar. Si los controles fallan, no se publica. Los IDs en `wrangler.jsonc` deben permanecer separados. La estructura y los datos no se reinician en cada despliegue.

## Comprobación después del despliegue

1. Abrir `/api/status`: devuelve `initialized` y el entorno, sin datos privados.
2. Crear superadministrador; iniciar/cerrar sesión.
3. Renombrar los colegios en Personalización.
4. Crear producto y cliente de prueba, cargar consumo, aumentar precio y cobrar parcialmente.
5. Probar usuario de otro colegio: no debe acceder a la cuenta.
6. Hacer un commit inocuo en la rama correspondiente y comprobar en Builds la publicación automática.
7. En `dev`, probar una foto de factura, corregir un renglón, guardar y volver a abrirla. Verificar que se ve el original, que el documento sigue como borrador y que ningún precio de venta o saldo cambió.

## Actualizaciones y respaldo

Las migraciones se registran por D1 y son incrementales. Esta primera migración no borra tablas. Las futuras deben ser compatibles con la versión todavía desplegada. Volver a una versión de Worker no revierte los datos ni las migraciones.

Exportación manual administrativa con Wrangler (requiere autenticación del propietario):

```sh
npx wrangler@4 d1 export PeloApp-prod --remote --output=backup-peloapp.sql
```

Guardar el respaldo fuera del repositorio público. La automatización a Drive aún no está implementada. Ensayar restauración en una base de pruebas antes de usar datos reales.
