import { useEffect } from 'react'
import { useDv } from './ctx'
import { NewProjectPanel } from './NewProjectPanel'
import { ProjectPanel } from './ProjectPanel'
import { QuestionWindow } from './QuestionWindow'
import { RequestWindow } from './RequestWindow'
import { SettingsModal } from './SettingsModal'
import { StatusChangeModal } from './StatusChangeModal'

/** Every window on the DevOps board, opened by URL parameters (and the status window by state). */
export function DevopsWindows() {
  const { db, get, setDd } = useDv()
  const key = get('project')
  const p = key ? db.projects.find(x => x.key === key) : undefined
  const request = get('request')
  const question = get('question')
  const settings = get('settings')
  const isNew = get('new')

  // A menu never outlives the window it was opened in.
  useEffect(() => setDd(null), [key, settings, isNew, setDd])

  return (
    <>
      {p && <ProjectPanel key={p.key} p={p} />}
      {isNew && <NewProjectPanel />}
      {settings && <SettingsModal tab={settings} />}
      {request && <RequestWindow id={+request} />}
      {question && <QuestionWindow id={+question} />}
      <StatusChangeModal />
    </>
  )
}
