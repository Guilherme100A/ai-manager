// Reserva das conversas sem IA: quando o modelo falha (sem crédito, sem chave, IA desligada, timeout), a fala sai de
// um banco de frases curtas em português, sorteadas e com pequenas variações, para o aquecimento não parar.
// Evita repetir o que está no histórico e o que o próprio chip mandou há pouco (o antiban bloqueia 3 textos
// idênticos na mesma hora).
import type { ConversationModel, ConversationTurn } from './index'

/** Abre o assunto. */
const OPENERS = [
  'Opa, tudo certo?', 'E aí, sumido', 'Fala, beleza?', 'Oi, tudo bem por aí?', 'Bom dia! Como tá?', 'Boa tarde, tudo tranquilo?',
  'Boa noite! Correria hoje?', 'Opa, quanto tempo', 'E aí, como foi o dia?', 'Fala aí, novidades?', 'Oii, tudo joia?',
  'E aí, firmeza?', 'Salve! Tudo em paz?', 'Opa, lembrei de você agora', 'E aí, conseguiu descansar?', 'Fala, tá na correria?',
  'Oi! Tá podendo falar?', 'E aí, como tão as coisas?', 'Opa, bom te ver por aqui', 'Bom dia, dormiu bem?',
]

/** Responde a uma pergunta da outra conta. */
const ANSWERS = [
  'Acho que sim', 'Pior que não sei', 'Depende muito kkk', 'Ainda não, mas quero', 'Sim, com certeza', 'Talvez, vou ver',
  'Acho que não viu', 'Então, ainda tô pensando', 'Vou ver isso amanhã', 'Por enquanto não', 'Já sim, curti bastante',
  'Não lembro agora kkk', 'Sim sim', 'Mais ou menos', 'Tô vendo ainda', 'Na real não sei te dizer', 'Acho que dá sim',
  'Vou confirmar e te falo', 'Ainda não tive tempo', 'Sim, tô dentro', 'Vixe, nem sei', 'Ainda não decidi', 'Provavelmente sim',
  'Hoje não consigo', 'Quem sabe no fim de semana', 'Não, mas tô curioso', 'Já, e gostei', 'Tô na dúvida ainda',
  'Tudo certo por aqui', 'Tudo bem sim, e você?', 'Tranquilo, e aí?', 'Na correria, mas de boa', 'Tudo joia graças a Deus',
]

/** Comenta ou reage à última fala. */
const COMMENTS = [
  'Boa, faz sentido', 'Verdade kkk', 'Pois é', 'Kkkkk demais', 'Nossa, sério?', 'Que massa', 'Caramba', 'Entendi',
  'Boa!', 'Show de bola', 'Faz tempo que não vejo isso', 'Pior que é verdade', 'Também acho', 'Ah, saquei', 'Que doideira',
  'Sabia não', 'Interessante isso', 'Aí sim', 'Top demais', 'Kkkk imaginei', 'Imagina só', 'Isso aí', 'Tô ligado',
  'Faz parte né', 'Normal isso', 'Rapaz kkk', 'Nem me fala', 'Achei massa', 'Boa ideia', 'Que bom!', 'Que legal',
  'Ah, beleza então', 'Fechou', 'Combinado', 'Justo', 'Tranquilo', 'Bem isso', 'Exatamente', 'Concordo total',
  'Olha só', 'Tá certo', 'Melhor assim', 'Faz bem', 'Que bom saber', 'Ah, que pena', 'Vixe kkk', 'Eita',
  'Puts, sério?', 'Me identifiquei kkk', 'Faz todo sentido', 'Nunca tinha pensado nisso', 'Gostei dessa',
]

/** Emenda na própria fala. */
const FOLLOW_UPS = [
  'Tô meio corrido hoje', 'Depois te conto melhor', 'Hoje o dia foi puxado', 'Mais tarde falo com calma',
  'Tô no trampo agora', 'Acabei de chegar em casa', 'Vou almoçar e já volto', 'Tô saindo agora', 'Semana tá corrida',
  'Ontem fiquei acordado até tarde', 'Hoje tô cansadão', 'Fim de semana chegando', 'Choveu muito aqui hoje',
  'Aqui tá um calor danado', 'Tô vendo umas coisas aqui', 'Tava pensando nisso esses dias', 'Lembrei disso agora',
  'Vou ver se consigo hoje', 'Amanhã vejo isso', 'Tô devendo isso faz tempo', 'Preciso organizar umas coisas',
  'Hoje rendeu bastante', 'O dia passou voando', 'Tô tentando descansar um pouco', 'Vou tomar um café',
  'Acordei cedo hoje', 'Tô sem bateria quase', 'Internet aqui tá ruim', 'Depois me lembra disso', 'Bora ver',
  'Tô jogando um pouco agora', 'Vi um vídeo sobre isso ontem', 'Comecei um jogo novo', 'Meu celular tá travando',
  'Tô assistindo uma série boa', 'Vou dar uma olhada depois', 'Faz tempo que quero ver isso', 'Tô curtindo bastante',
]

/** Pergunta curta (só quando não há pergunta própria ainda sem resposta). */
const QUESTIONS = [
  'E você?', 'Como tá aí?', 'Conseguiu ver?', 'O que achou?', 'Vai fazer o que hoje?', 'Tá jogando alguma coisa?',
  'Viu alguma série boa?', 'Tá trabalhando hoje?', 'Bora marcar algo?', 'Tudo certo por aí?', 'E aí, o que me conta?',
  'Tem novidade?', 'Já almoçou?', 'Vai sair hoje?', 'Curtiu?', 'Sabe se vai rolar?', 'Conhece alguém que joga?',
  'Tá vendo o quê agora?', 'Vai no fim de semana?', 'Lembra daquele dia?', 'Faz quanto tempo isso?', 'Testou já?',
]

/** Respostas a quem acabou de cumprimentar ("tudo bem?"). */
const GREETINGS_REPLY = [
  'Tudo ótimo e você?', 'Tudo certo, e aí?', 'Tô bem, graças a Deus', 'De boa, e contigo?', 'Tudo tranquilo por aqui',
  'Na luta kkk e você?', 'Tudo em paz', 'Bem demais, e aí?', 'Tô bem sim', 'Aqui tudo certo',
]

const TAILS = ['', '', '', '', ' kkk', ' kkkk', ' rs', '!', ' haha', ' 😅', ' 😂', ' 👍', ' 🔥', ' 🙏']
/** Memória por chip das falas de reserva recentes (cobre com folga a janela de 1 h do antiban). */
const RECENT_MAX = 80

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()

export class PhraseConversationModel implements ConversationModel {
  private readonly recent = new Map<string, string[]>()

  constructor(private readonly random: () => number = Math.random) {}

  async message(_topic: string, senderId: string, history: ConversationTurn[], parts = 1): Promise<string> {
    const count = Math.max(1, Math.min(3, Math.floor(parts)))
    const recent = this.recent.get(senderId) ?? []
    const used = new Set([...history.slice(-10).map((t) => norm(t.text)), ...recent.map(norm)])
    const last = history.at(-1)
    const fromOther = last && last.senderId !== senderId ? last.text : undefined
    // Sem perguntas enquanto a própria pergunta (desde a última fala da outra conta) está sem resposta.
    const ownSince = history.slice(history.findLastIndex((t) => t.senderId !== senderId) + 1)
    let asked = ownSince.some((t) => t.text.includes('?'))

    const first = !last ? OPENERS
      : !fromOther ? FOLLOW_UPS
        : /\b(tudo (bem|certo|joia|tranquilo)|como (vai|ta|voce))\b/.test(norm(fromOther)) ? GREETINGS_REPLY
          : fromOther.includes('?') ? ANSWERS : COMMENTS
    const lines: string[] = []
    for (let i = 0; i < count; i++) {
      const pool = i === 0 ? first : !asked && this.random() < 0.35 ? QUESTIONS : FOLLOW_UPS
      const line = this.pick(pool, used, i === count - 1)
      if (line.includes('?')) asked = true
      used.add(norm(line))
      lines.push(line)
    }
    this.recent.set(senderId, [...recent, ...lines].slice(-RECENT_MAX))
    return lines.join('\n')
  }

  /** Frase ainda não usada (ou a menos recente, se o banco esgotar), com variação de caixa e final. */
  private pick(pool: readonly string[], used: Set<string>, lastLine: boolean): string {
    const fresh = pool.filter((p) => !used.has(norm(p)))
    const base = (fresh.length ? fresh : pool)[Math.floor(this.random() * (fresh.length || pool.length))]!
    let text = this.random() < 0.3 ? base.charAt(0).toLowerCase() + base.slice(1) : base
    // Final só na última linha, e nunca depois de pergunta.
    if (lastLine && !text.endsWith('?')) text = text.replace(/!$/, '') + TAILS[Math.floor(this.random() * TAILS.length)]!
    return text
  }
}

export interface FallbackLogger { warn(obj: object, message?: string): void }

/** Tenta a IA e, se ela falhar por qualquer motivo, usa o banco de frases. */
export class FallbackConversationModel implements ConversationModel {
  constructor(
    private readonly primary: ConversationModel,
    private readonly fallback: ConversationModel = new PhraseConversationModel(),
    private readonly logger?: FallbackLogger,
  ) {}

  async message(topic: string, senderId: string, history: ConversationTurn[], parts?: number): Promise<string> {
    try {
      return await this.primary.message(topic, senderId, history, parts)
    } catch (err) {
      this.logger?.warn({ session_id: senderId, err: err instanceof Error ? err.message.slice(0, 160) : String(err) }, 'conversation ai failed; using phrase fallback')
      return this.fallback.message(topic, senderId, history, parts)
    }
  }
}
