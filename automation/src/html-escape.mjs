/**
 * Escape de HTML para o relatório operacional.
 *
 * Todo o conteúdo do relatório é **não confiável**: trechos de log do CI, saída
 * da Railway CLI, mensagens de erro da aplicação e texto gerado por um modelo.
 * Qualquer um deles pode conter `<script>`, `onerror=`, `"` fechando um atributo
 * ou `javascript:` numa URL — e o relatório é um arquivo que alguém vai abrir no
 * navegador.
 *
 * A abordagem é a conservadora: **um** escapador, aplicado a **tudo**, cobrindo
 * também os dois casos que a lista mínima costuma esquecer:
 *
 * - `'` (aspas simples), porque atributo com aspas simples é comum e um escape
 *   que só cobre `"` deixa a porta aberta;
 * - `` ` `` (crase), porque versões antigas do IE tratavam crase como delimitador
 *   de atributo — custo zero manter, e é o tipo de detalhe que ninguém revisita.
 *
 * Não existe função "escape só um pouquinho" neste módulo de propósito: a
 * primeira exceção conveniente é como um relatório passa a executar o log que
 * deveria exibir.
 */

const ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '=': '&#61;',
};

const ESCAPABLE = /[&<>"'`=]/g;

/**
 * Escapa texto para inserção em conteúdo **ou** em atributo.
 *
 * `=` também é escapado: em atributo sem aspas (que este relatório não usa, mas
 * um editor futuro pode introduzir), é o caractere que separa `onerror` do seu
 * valor.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(ESCAPABLE, (char) => ENTITIES[char]);
}

/**
 * Limita o tamanho de um texto **antes** do escape.
 *
 * A ordem importa: cortar depois do escape poderia partir uma entidade ao meio
 * (`&am`), o que o navegador renderiza como texto quebrado — e, num caso
 * infeliz, reabre o que a entidade fechava.
 *
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string} já escapado
 */
export function escapeTruncated(value, maxLength = 2000) {
  const text = String(value ?? '');
  const cut = text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  return escapeHtml(cut);
}

/**
 * Um identificador seguro para `id`/`href="#..."`.
 *
 * Só letras, números e hífen. Nada que venha de fora entra em atributo de
 * âncora sem passar por aqui.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function slug(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'secao';
}
