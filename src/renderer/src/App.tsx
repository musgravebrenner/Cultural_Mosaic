import LeftPanel from './components/LeftPanel'
import MosaicCanvas from './components/MosaicCanvas'
import Toolbar from './components/Toolbar'

export default function App(): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Toolbar />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <LeftPanel />
        <div style={{ flex: 1, minWidth: 0 }}>
          <MosaicCanvas />
        </div>
      </div>
    </div>
  )
}
