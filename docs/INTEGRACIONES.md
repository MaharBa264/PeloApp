# Enlaces de estado de cuenta, WhatsApp y Mercado Pago

## Estado de cuenta por enlace (listo para usar)

En el detalle de una cuenta, **Enviar estado de cuenta** crea un enlace privado de **solo lectura** (`/estado.html#<token>`) que muestra el saldo, los ítems pendientes y los últimos pagos. No muestra teléfono, correo ni notas del cliente.

- El token es aleatorio (256 bits); en la base solo se guarda su hash. Vigencia de 1 a 90 días. Se puede revocar todo lo emitido para la cuenta.
- El token va en el fragmento de la URL (`#`), que el navegador no envía al servidor, así que no queda en registros de acceso.
- El botón **Abrir WhatsApp** usa `https://wa.me/?text=...` **sin número**: WhatsApp deja elegir el chat. Se hizo así a propósito: deducir el número desde el campo "contacto" (texto libre) podía mandar deuda a una persona equivocada.
- Cada emisión y revocación queda en Auditoría.

### Próximo paso: envío automático por WhatsApp Business
Requiere una cuenta de WhatsApp Business Platform (Meta), un número verificado y plantillas de mensaje aprobadas. La app ya tiene lo necesario del lado de los datos (enlace por cuenta, reporte de deudores con antigüedad). Faltaría un número de contacto estructurado por cuenta (hoy es texto libre) y una tarea programada que recorra el reporte de deudores.

## Cobro con Mercado Pago (preparado, desactivado hasta configurar)

La integración está desarrollada, pero **solo se probó contra una simulación de la API**, escrita a partir de la documentación de Mercado Pago. Antes de usarla con dinero real hay que probarla de punta a punta en `dev` con credenciales de prueba.

### Cómo funciona
1. En una cuenta: **Cobrar con Mercado Pago** → importe → se crea una preferencia de Checkout Pro y se obtiene un enlace de pago (con botón para WhatsApp).
2. La familia paga. Mercado Pago avisa a `POST /api/webhooks/mercadopago`.
3. El Worker **verifica la firma** (`x-signature`, HMAC-SHA256 con el secreto del webhook), **consulta el pago a la API de Mercado Pago** (nunca confía en el cuerpo del aviso) y, si está `approved`, en pesos y por el **importe exacto** solicitado, lo registra en la cuenta como un pago con medio "Mercado Pago" (los más antiguos primero, el excedente queda como anticipo).
4. Es idempotente: reenvíos del mismo aviso no duplican nada. Se puede anular como cualquier otro pago.
5. Si el importe no coincide, la solicitud queda en **revisión** (se ve en la cuenta y en Auditoría) y no se aplica nada automáticamente.

### Configuración (por entorno: `dev` y producción separados)
En Cloudflare → Worker → Settings → Variables and Secrets, como **Secret**:

| Nombre | Valor |
| --- | --- |
| `MP_ACCESS_TOKEN` | Access token de la aplicación de Mercado Pago (de prueba en `dev`) |
| `MP_WEBHOOK_SECRET` | "Clave secreta" del webhook, generada en el panel de Mercado Pago |

En el panel de Mercado Pago Developers → tu aplicación → Webhooks → configurar `https://<tu-worker>/api/webhooks/mercadopago` con el evento **Pagos**. Mientras falte cualquiera de los dos secretos, el botón no aparece y el endpoint responde 503.

### Limitaciones conocidas
- **Devoluciones y contracargos** no se detectan: si se devuelve un pago en Mercado Pago, anulá el pago en la cuenta a mano.
- Un pago aprobado sobre una solicitud ya cancelada se acepta igual si el importe coincide (el dinero ya entró).
- **QR:** hoy se entrega el enlace de pago. Un QR es solo mostrar ese mismo enlace como imagen; queda pendiente.
- Si la app cae justo cuando llega el aviso, Mercado Pago reintenta.

## Recuperación de acceso

- **Cambiar mi contraseña:** botón en el menú lateral (cierra las otras sesiones).
- **Olvidó su contraseña:** un administrador abre Usuarios → Editar → **Generar enlace de recuperación** y se lo envía a la persona por un medio privado. Sirve una vez y vence en 1 hora. Un administrador no puede generar el enlace de un superadministrador.
- **Se perdió el único superadministrador:** desde una computadora con Wrangler,
  ```sh
  NEW_PASSWORD='una-clave-larga-nueva' node scripts/reset-password.mjs correo@del.superadmin > reset.sql
  npx wrangler@4 d1 execute PeloApp-prod --remote --file reset.sql   # dev: PeloApp-dev --remote --env dev
  rm reset.sql
  ```
  (No hay recuperación por correo porque la app no envía emails todavía.)
