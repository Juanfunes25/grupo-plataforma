# POS sin conexión: cómo funciona y qué riesgo fiscal tiene

> Estado: implementado (mejora 5). Probado con pruebas automáticas (`packages/shared/test/cola-offline.test.js`, `apps/api/test/pos-offline.test.js`) y con un navegador real simulando cortes de internet.

## Qué hace la caja cuando se cae el internet

1. **Sigue abriendo.** La aplicación se instala como PWA (service worker) y guarda el catálogo, los precios, las formas de pago, el estado del CAI y la última sesión. Reiniciar la computadora o recargar sin internet no la bloquea.
2. **Sigue vendiendo en efectivo.** Aparece «Sin conexión · modo local». El cajero arma la orden igual, cobra (F2 o «Efectivo recibido y cambio» F4) y se imprime un **comprobante provisional** `OFF-<caja>-0001` que dice *NO ES FACTURA*.
3. **La venta queda en una cola local** (IndexedDB del navegador: sobrevive a cerrar Chrome y a reiniciar). La barra muestra «N ventas por sincronizar».
4. **Al volver la señal se sincroniza sola** (evento `online`, cada 20 s, y al volver a la pestaña), esté la persona en la pantalla que esté. El servidor asigna entonces el **número fiscal real** y la venta queda como cualquier otra, con el número provisional anotado al lado.

## Qué NO se permite sin conexión

| Acción | Por qué |
|---|---|
| Cobrar con tarjeta o transferencia | Necesitan validarse en el momento; el servidor además rechaza cualquier venta offline que no sea 100 % efectivo. |
| Vender piedra (EcoStone) | No se puede verificar la existencia ni reservar el lote. |
| Dejar la orden «en espera» y ver órdenes abiertas de otras cajas | Viven en el servidor. |
| Anular facturas, notas, reimprimir facturas del servidor | Requieren al servidor y autorización; las anulaciones nunca se encolan. |
| Cerrar la caja con ventas sin sincronizar | El cuadre quedaría incompleto: primero se sincroniza (o se resuelven las rechazadas). |
| Ventas mayores al umbral de RTN sin RTN | Misma regla de siempre. |

## Numeración y riesgo fiscal (leer con el contador)

El correlativo del SAR (`001-001-01-00000123`) **no se asigna en la caja**. Se asigna en el servidor, dentro de `pos.cobrar_venta`, con el bloqueo de fila del punto de emisión: nunca se repite ni se salta (probado con envíos simultáneos). Esa fue la decisión de diseño; la alternativa fue **reservar un rango por caja** (por ejemplo, la caja 1 usa del 1 al 50, la caja 2 del 51 al 100) para poder imprimir el número fiscal real sin internet.

| | Número provisional que asigna el servidor (implementado) | Rango reservado por caja (no implementado) |
|---|---|---|
| Sin repetidos ni huecos | Sí, siempre | Hay huecos si una caja no usa su rango; los números llegan **desordenados en fecha** |
| Lo que recibe el cliente sin internet | Comprobante provisional, **no es factura** | Factura fiscal completa |
| Riesgo con el SAR | El cliente se lleva un papel que no es factura; la factura existe (con fecha de emisión real = momento de sincronizar) pero no la tiene en la mano | Números fuera de orden cronológico entre cajas; rangos sin usar que hay que justificar o anular |
| Complejidad | Baja | Alta (rangos, devolución, anulación de huecos) |

**Mientras el sistema está en BORRADOR (sin CAI real) el riesgo no existe**: nada tiene valor fiscal. Antes de activar el CAI real hay que decidir con el contador cuál de las dos opciones se usa (ver pregunta al dueño en el informe). Mientras tanto la regla operativa es: **si el comprobante provisional sale, el cliente debe poder recibir su factura después** (correo o recoger), o la tienda no debe vender sin conexión cuando exista CAI real.

Otros riesgos conocidos:

- **Fecha**: `fecha_emision` es el momento de sincronizar; la hora real de la venta se guarda en `vendida_at`. Una venta de las 11 p. m. sincronizada al día siguiente queda en el día siguiente en los reportes por fecha de emisión (el cierre de caja la bloquea: no se puede cerrar con ventas pendientes).
- **Precios**: se recalculan en el servidor al sincronizar. Si el precio subió y el cliente pagó de menos, la venta **no** se factura sola: queda en «por revisar» (código `precio_cambio`) para un encargado. Si bajó, se factura al nuevo precio y la diferencia queda en `offline_info`. Todo queda en la bitácora (`venta_offline_sincronizada`).
- **Cajero**: la factura queda a nombre de quien sincroniza; el cajero original va en `offline_info.cajero_nombre`.
- **Reloj del equipo**: una hora futura se recorta a «ahora».
- **Caja que nunca vuelve a conectarse** (computadora dañada): las ventas de su cola se pierden junto con el disco. No hay copia hasta sincronizar.

## No duplicar (idempotencia)

Cada venta nace con un `id_cliente` (UUID) que no cambia nunca. El servidor lo guarda con un índice único `(empresa_id, id_cliente)`; si la misma venta llega otra vez (reintento, respuesta perdida, dos pestañas) devuelve la factura que ya existe con `duplicado: true`. Esto cubre también el caso peligroso: **el cobro normal sí llegó al servidor pero la respuesta se perdió**. La caja detecta el corte, reintenta como venta sin conexión con el *mismo* `id_cliente` y la *misma* orden (`orden_id`), y el servidor responde con la factura original; en la factura queda anotado el comprobante provisional que se entregó.

## Ventas «por revisar»

Un rechazo definitivo del servidor (precio cambiado, producto retirado, orden ya cobrada en otra caja, sin existencia bloqueante) **no borra** la venta ni frena a las demás: queda en la lista «Ventas por sincronizar» con el motivo. Un encargado puede **Reintentar** o **Descartar** (permiso `pos:anular`, con motivo; queda en la bitácora como `offline.descartada`).

## Dónde está cada cosa

- Lógica de la cola (pura, probada): `packages/shared/src/colaOffline.js`
- Almacenamiento y envío: `apps/web/src/pos/colaLocal.js` · sincronizador global: `apps/web/src/pos/Sincronizador.jsx`
- Servidor: `POST /api/pos/ventas` (con `id_cliente`, `orden_id`, `offline`) y `POST /api/pos/ventas/:id/cobrar` (con `id_cliente`) en `apps/api/src/modulos/pos/ventas.js`; migración `supabase/migrations/0090_pos_offline_favoritos.sql`.
- Comprobante provisional: `formatearTicketProvisional` en `packages/shared/src/ticket.js`.
