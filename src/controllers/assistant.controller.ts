import { Request, Response } from 'express';
import { z } from 'zod';

const messageSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      })
    )
    .max(20)
    .default([]),
});

const assistantInstructions = [
  'Você é o assistente de produtividade e estudos do Task Manager.',
  'Responda em português brasileiro, com clareza, empatia e orientações práticas.',
  'Ajude a organizar prioridades, rotinas, estudos e objetivos pessoais.',
  'Não afirme que criou ou alterou tarefas, objetivos ou eventos no aplicativo.',
].join(' ');

type OpenAIResponse = {
  output_text?: string;
};

export async function chatWithAssistant(req: Request, res: Response) {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Envie uma mensagem válida e até 20 mensagens anteriores.',
      details: parsed.error.flatten(),
    });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res
      .status(503)
      .json({ error: 'O assistente ainda não está configurado no servidor.' });
    return;
  }

  try {
    const upstream = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
        instructions: assistantInstructions,
        input: [
          ...parsed.data.history.map(({ role, content }) => ({
            role,
            content,
          })),
          { role: 'user', content: parsed.data.message },
        ],
        max_output_tokens: 800,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!upstream.ok) {
      const errorBody = await upstream.text();

      console.error('Erro OpenAI:', {
        status: upstream.status,
        details: errorBody,
      });

      res.status(502).json({
        error: 'Falha na API da OpenAI.',
        status: upstream.status,
        details: JSON.parse(JSON.stringify(errorBody)),
      });

      return;
    }

    // res.status(200).json({ message });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      res.status(504).json({
        error: 'O assistente demorou para responder. Tente novamente.',
      });
      return;
    }
    console.error('Falha ao conectar com a OpenAI:', error);
    res
      .status(502)
      .json({ error: 'Não foi possível conectar ao assistente agora.' });
  }
}
