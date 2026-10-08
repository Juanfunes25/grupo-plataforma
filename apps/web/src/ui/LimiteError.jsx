import { Component } from 'react';

/**
 * Red de seguridad: si una pantalla falla al dibujarse (un hook mal usado, un dato inesperado), se muestra un aviso con
 * salida en vez de dejar TODA la aplicación en blanco. Se reinicia solo al cambiar de pantalla (`reinicio`).
 */
export default class LimiteError extends Component {
  state = { error: null, reinicio: this.props.reinicio };

  static getDerivedStateFromError(error) { return { error }; }

  static getDerivedStateFromProps(props, state) {
    return props.reinicio !== state.reinicio ? { error: null, reinicio: props.reinicio } : null;
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[pantalla] error al dibujar:', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="pagina">
        <div className="aviso-caja mal" role="alert" style={{ display: 'grid', gap: 10 }}>
          <b>Esta pantalla tuvo un problema y no se pudo mostrar.</b>
          <span>Tus datos guardados no se perdieron. Puedes volver a intentar o ir al inicio.</span>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => this.setState({ error: null })}>Reintentar</button>
            <button className="btn" onClick={() => { window.location.assign('/'); }}>Ir al inicio</button>
            <button className="btn fantasma" onClick={() => window.location.reload()}>Recargar la página</button>
          </span>
        </div>
      </div>
    );
  }
}
