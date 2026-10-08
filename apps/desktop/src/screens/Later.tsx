// Scripts, Commit and Pipelines arrive after the slice (architecture.md build order).
import { Construction } from 'lucide-react'
import { Card, EmptyState } from '../ui/display'

const what = {
  Commit: 'Commit and push from inside LiftOff. Until then, use your usual git client.',
  Pipelines: 'Generate a CI workflow that runs your migrations. Until then, call `liftoff migrate` from your pipeline.',
}

export function Later({ what: w }: { what: keyof typeof what }) {
  return (
    <div className="p-8">
      <Card><EmptyState icon={Construction} text={`Not built yet. ${what[w]}`} /></Card>
    </div>
  )
}
