import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../stores/projectStore'
import { MarkdownEditor } from './MarkdownEditor'
import { useSceneNotesDocument } from './useSceneNotesDocument'

interface SceneSynopsisFieldProps {
  chapterGuid: string
  sceneId: string
  id?: string
  className: string
  placeholder?: string
  multiline?: boolean
}

export function SceneSynopsisField(props: SceneSynopsisFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const scene = useProjectStore(state => state.chapters.find(chapter => chapter.guid === props.chapterGuid)?.scenes.find(scene => scene.id === props.sceneId))
  const prose = scene?.sharedProse
  const itemId = prose?.fields.synopsis
  if (prose && itemId) return <MarkdownEditor key={itemId} shared={{ sessionId: prose.sessionId, itemId }}
    value={scene?.synopsis ?? ''} ariaLabel={t('sceneNotes.synopsisTitle')} minRows={props.multiline ? 3 : 1}
    showToolbar={false} onChange={() => {}} />
  return <LocalSceneSynopsisField {...props} />
}

function LocalSceneSynopsisField({ chapterGuid, sceneId, multiline = false, ...props }: SceneSynopsisFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const projectPath = useProjectStore(state => state.projectPath)
  const bookId = useProjectStore(state => state.activeBookId)
  const draftId = useProjectStore(state => state.activeDraftId)
  const epoch = useProjectStore(state => state.workspaceEpoch)
  const { document, state } = useSceneNotesDocument({
    projectPath: projectPath ?? '', bookId, draftId, epoch, chapterGuid, sceneId, title: ''
  }, 'synopsis')
  const save = (): void => { void document.flush().catch(() => {}) }
  const inputProps = {
    ...props,
    'aria-label': t('sceneNotes.synopsisTitle'),
    disabled: !state.loaded,
    value: state.text,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => document.update(event.target.value),
    onBlur: save
  }
  return <>
    {multiline ? <textarea {...inputProps} /> : <input {...inputProps} />}
    {state.error && <span role="alert">
      {t('toast.saveFailed').replace('{0}', state.error)}
      <button type="button" className="btn-secondary" onClick={() => state.loaded ? save() : void document.load()}>{t('shell.retry')}</button>
    </span>}
  </>
}
