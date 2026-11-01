import type { PoolClient } from 'pg';

export type ActivityEventType =
  | 'checklist_item_completed'
  | 'goal_step_completed'
  | 'goal_completed'
  | 'objective_step_completed'
  | 'objective_completed';

const messageTemplates: Record<ActivityEventType, string[]> = {
  checklist_item_completed: [
    'Muito bem! Mais uma tarefa concluída. Continue nesse ritmo!',
    'Boa! Você avançou mais um passo no seu dia.',
    'É isso aí! Cada tarefa concluída aproxima você dos seus objetivos.',
    'Mandou bem! Seu esforço de hoje está fazendo a diferença.',
  ],
  goal_step_completed: [
    'Muito bem! Mais uma etapa da sua meta foi concluída.',
    'Você está avançando! Etapa concluída com sucesso.',
    'Boa! Consistência transforma planos em conquistas.',
  ],
  goal_completed: [
    'Meta concluída, top! Você conseguiu — comemore essa conquista!',
    'Incrível! Sua meta foi concluída. Que conquista!',
    'Você chegou lá! Meta concluída com muito mérito.',
    'Meta concluída! Todo aquele esforço valeu a pena.',
  ],
  objective_step_completed: [
    'Boa! Mais uma etapa do seu objetivo foi concluída.',
    'Você está chegando lá! Etapa do objetivo concluída.',
    'Progresso feito: mais uma etapa concluída com sucesso.',
  ],
  objective_completed: [
    'Objetivo concluído, top! Você transformou seu plano em resultado.',
    'Parabéns! Mais um objetivo importante foi concluído.',
    'Conquista desbloqueada! Seu objetivo está concluído.',
  ],
};

export function activityMessage(type: ActivityEventType): string {
  const messages = messageTemplates[type];
  return messages[Math.floor(Math.random() * messages.length)];
}

export async function recordActivity(
  client: PoolClient,
  userId: number,
  type: ActivityEventType,
  entityId: number,
  title: string
) {
  const message = activityMessage(type);
  const result = await client.query(
    `INSERT INTO public.activity_events (user_id, event_type, entity_id, title, message)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, event_type, entity_id, title, message, created_at`,
    [userId, type, entityId, title, message]
  );
  return result.rows[0];
}
