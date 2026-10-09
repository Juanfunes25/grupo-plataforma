# Plan de mejoras — Plataforma del Grupo

Estado: propuesto al dueño; se lanza por olas (varios agentes a la vez, cada uno con sus archivos).

## 25 mejoras importantes (cada una con su agente)

### Experiencia de app (celular y tablet primero)
1. **Navegación tipo app**: barra inferior por rol (Inicio · Facturar · Pesaje/Producción · Más) en celular. — Agente UI-UX
2. **Hojas deslizables, gestos y transiciones** en lugar de ventanas emergentes de sitio web. — Agente UI-UX
3. **App instalable de verdad (PWA completa)**: iconos y pantalla de arranque por empresa, pantalla completa, modo quiosco para tablets, aviso de versión nueva. — Agente PWA
4. **POS final**: favoritos, búsqueda rápida, teclado numérico, cobro de un toque, atajos, vista de una mano. — Agente POS
5. **POS sin conexión real**: ventas en cola con numeración segura y sincronización. — Agente Offline
6. **Impresión**: ticket térmico (Bluetooth/USB/red), plantilla de factura con logo, reimpresión controlada, PDF. — Agente Impresión
7. **Tablero del dueño en el celular**: hoy vs ayer vs semana pasada, tarjetas, actualizar al deslizar. — Agente Dashboard
8. **Notificaciones push**: tienda sin pesar, CAI por vencer, documentos por vencer, alertas antifraude, despacho por confirmar. — Agente Notificaciones
9. **Correo y WhatsApp**: facturas, cotizaciones, resumen diario y alertas. — Agente Mensajería
10. **Asistente fiscal por empresa**: razón social, RTN, CAI, rangos, modo prueba claro y alertas. — Agente Fiscal
11. **Tema claro/oscuro/alto contraste** para sol y poca luz, tamaño de letra y densidad ajustables. — Agente UI-UX
12. **Ayuda dentro de la app**: recorridos guiados por rol, ayuda en cada pantalla, manual por rol. — Agente Ayuda
13. **Búsqueda global** de facturas, clientes, productos, empleados y documentos. — Agente Búsqueda
14. **Rendimiento**: arranque rápido, caché, carga por partes, medición con Lighthouse. — Agente Rendimiento
15. **Accesibilidad y lenguaje**: lector de pantalla, español de Honduras consistente, formatos de moneda y fecha. — Agente Accesibilidad

### Negocio
16. **Finanzas del grupo**: flujo de caja, cuentas por cobrar y por pagar, presupuesto vs real, intercompañía. — Agente Finanzas
17. **Compras y proveedores**: órdenes de compra, recepción, costo promedio, comparativo de precios (insumos MEC3 dolarizados). — Agente Compras
18. **Inventario unificado**: conteos cíclicos, transferencias entre sucursales y empresas, alertas de mínimos. — Agente Inventario
19. **Planilla Honduras**: IHSS, RAP, INFOP, ISR, décimo tercero y catorceavo, boletas en PDF. — Agente Planilla
20. ~~Clientes y fidelización~~ — DESCARTADA por el dueño.
21. **Cobranza de EcoStone y DISERCO**: seguimiento de cotizaciones, recordatorios, cobros parciales, estado de cuenta. — Agente Comercial
22. ~~Reportes programados~~ — DESCARTADA por el dueño.
23. **Seguridad**: verificación en dos pasos para dueño y administradores, sesiones activas, permisos finos, rotación de claves. — Agente Seguridad
24. **Respaldos y salud**: copias exportables, restauración probada, monitoreo de errores y caídas con aviso. — Agente Confiabilidad
25. **Puente con WizPOS (solo lectura)**: ventas de las tiendas en el tablero y conciliación contra la plataforma durante la migración. — Agente Integración

## Ideas de nivel superior (el dueño descartó la 2, 6, 7, 8, 11, 12, 13, 14, 16, 17 y 19)
Se hacen una por una, preguntando el detalle antes de construir cada una:
1. Gerente digital conversacional: preguntas en lenguaje natural sobre los números.
3. Margen guía y precios sugeridos con el costo dolarizado de MEC3.
4. Lectura por foto de facturas de proveedores (compras) y de pesajes.
5. Detección de anomalías de fraude con aprendizaje de patrones.
9. Contabilidad automática: asientos y declaración mensual de ISV lista.
10. Facturación electrónica del SAR cuando aplique.
15. Catálogo B2B de Ristoris con pedidos de clientes.
18. Evaluación de desempeño y capacitación corta para empleados.
20. Simulador «qué pasaría si» (precios, costos, abrir una sucursal nueva) y rentabilidad por sucursal y producto.
