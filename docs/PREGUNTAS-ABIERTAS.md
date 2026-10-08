# Decisiones que necesito de ti

Lo que asumí para avanzar está al lado de cada pregunta; dime si algo no aplica y lo ajusto.

## Fiscal y contable (con tu contador)
1. **Origen — datos fiscales**: razón social, RTN, dirección y si facturará con CAI desde el día 1.
   *Asumí:* arranca en modo BORRADOR hasta que me pases el CAI.
2. **ISV en Origen**: ¿la fruta/verdura fresca sin procesar va **exenta** y el jugo/smoothie/bowl preparado
   lleva **15 %**? *Asumí que sí* (producto "exento" = 0 %, preparados = 15 %). Confírmalo con el contador.
3. **Exento vs exonerado**: hoy un producto exento por ley cae en "exento" y uno a 0 % sin esa marca en
   "exonerado". ¿Así lo declara tu contador?
4. **Un CAI por sucursal** (como hoy en Italo) — *asumí que sí*.

## Origen
5. ¿Cuántas sucursales tendrá y dónde? *Asumí 1 ("Origen · Principal").*
6. **Menú y precios reales** (el catálogo cargado es de ejemplo). ¿Me pasas la lista, o la cargas tú desde Catálogo?
7. ¿Habrá **delivery**, **pedidos por adelantado/programas de jugos (cleanses)**, **suscripciones** o **puntos de lealtad** desde el inicio?
8. ¿Venderás fruta/verdura al **peso** como producto de góndola (con báscula) o solo preparados?
9. ¿Proveedores principales y unidades de compra (cajas, quintales, libras)?

## Italo
10. ¿**Cuándo** quieres reemplazar WizPOS: tienda por tienda o todas a la vez? *Asumí: en paralelo y tienda por tienda.*
11. Progreso: hoy el dashboard lista 5 sucursales y facturación 4. ¿Progreso sigue activa? *Asumí 4.*
12. ¿La **producción de gelato (Los Andes)** es la prioridad #2 después del POS, o prefieres EcoStone primero?

## Equipo y accesos
13. ¿Quién necesita **correo + contraseña** (dueños, gerentes, contador) y quién **PIN** (cajeros, cocina)?
14. ¿Algún usuario que deba ver **todas** las empresas sin ser dueño (ej. administradora general)? Se resuelve con rol + `grupo:ver`.
15. Política de PIN: ¿cada cajero su PIN personal (recomendado, queda en bitácora quién cobró)?

## Hardware y operación
16. Impresoras térmicas (¿80 mm? ¿marca/modelo?), gaveta de dinero, lector de código de barras, tablets/pantalla de cocina.
17. Internet en cada local: ¿hay respaldo (datos móviles)? Define qué tan urgente es el modo sin conexión.

## Infraestructura
18. **Dónde vive el código**: hoy está en `plataforma/` dentro del repo `italo-facturacion`, rama
    `claude/unified-multi-business-system-9zc0pa`. ¿Creamos un repositorio propio (ej. `grupo-plataforma`)?
    Es recomendable: se conserva el historial con `git subtree split`.
19. **Dominio** (ej. `app.tugrupo.com`) y correo remitente para facturas.
20. ¿Contratas **Supabase Pro** desde el inicio (respaldos diarios)? Lo recomiendo si facturas de verdad.
