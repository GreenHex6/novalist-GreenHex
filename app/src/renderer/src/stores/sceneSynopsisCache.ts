import type { SceneNotesContext } from '../../../shared/sceneNotesProtocol'
import { useProjectStore } from './projectStore'
import { useManuscriptStore } from './manuscriptStore'

export function cacheSceneSynopsis(context: SceneNotesContext, text: string): void {
  const workspace = useProjectStore.getState()
  if (workspace.projectPath !== context.projectPath || workspace.activeBookId !== context.bookId || workspace.activeDraftId !== context.draftId) return
  const synopsis = text || null
  useProjectStore.setState({ chapters: workspace.chapters.map(chapter => chapter.guid !== context.chapterGuid ? chapter : {
    ...chapter, scenes: chapter.scenes.map(scene => scene.id === context.sceneId ? { ...scene, synopsis } : scene)
  }) })
  useManuscriptStore.setState(state => ({ sections: state.sections.map(section => section.chapterGuid !== context.chapterGuid ? section : {
    ...section, scenes: section.scenes.map(scene => scene.sceneId === context.sceneId ? { ...scene, synopsis } : scene)
  }) }))
}
