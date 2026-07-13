import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from './App.jsx';
import { api } from './api.js';

vi.mock('./api.js', () => ({
  api: {
    health: vi.fn(),
    listStickers: vi.fn(),
    getReport: vi.fn(),
    createSticker: vi.fn(),
    changeQuantity: vi.fn(),
    deleteSticker: vi.fn(),
  },
}));

const stickers = [
  {
    id: 's1',
    albumNumber: 1,
    playerName: 'Marcos Vieira',
    country: 'Brasil',
    countryCode: 'BR',
    position: 'goalkeeper',
    quantity: 1,
    duplicateCopies: 0,
  },
  {
    id: 's2',
    albumNumber: 2,
    playerName: 'Rafael Andrade',
    country: 'Brasil',
    countryCode: 'BR',
    position: 'defender',
    quantity: 0,
    duplicateCopies: 0,
  },
  {
    id: 's3',
    albumNumber: 3,
    playerName: 'Lucas Ferreira',
    country: 'Argentina',
    countryCode: 'AR',
    position: 'midfielder',
    quantity: 3,
    duplicateCopies: 2,
  },
];

const report = {
  totalRegistered: 3,
  obtained: 2,
  missing: 1,
  duplicateCopies: 2,
  completionPercentage: 67,
  byCountry: [
    { country: 'Argentina', countryCode: 'AR', total: 1, obtained: 1, missing: 0, duplicateCopies: 2 },
    { country: 'Brasil', countryCode: 'BR', total: 2, obtained: 1, missing: 1, duplicateCopies: 0 },
  ],
  missingStickers: [
    { id: 's2', albumNumber: 2, playerName: 'Rafael Andrade', country: 'Brasil', countryCode: 'BR', position: 'defender', quantity: 0 },
  ],
  duplicateStickers: [
    { id: 's3', albumNumber: 3, playerName: 'Lucas Ferreira', country: 'Argentina', countryCode: 'AR', position: 'midfielder', quantity: 3, duplicateCopies: 2 },
  ],
};

function getCard(playerName) {
  return screen.getByText(playerName).closest('article');
}

async function renderAppLoaded() {
  render(<App />);
  await waitFor(() => expect(screen.queryByText('Carregando…')).not.toBeInTheDocument());
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listStickers.mockResolvedValue(stickers);
  api.getReport.mockResolvedValue(report);
});

describe('título CopaFigurinhas', () => {
  it('exibe o título da aplicação', async () => {
    await renderAppLoaded();
    expect(screen.getByRole('heading', { name: 'CopaFigurinhas' })).toBeInTheDocument();
  });
});

describe('painel de indicadores', () => {
  it('exibe conclusão, obtidas, faltantes e repetidas', async () => {
    await renderAppLoaded();
    const indicators = screen.getByLabelText('Indicadores do álbum');
    expect(indicators).toHaveTextContent('67%');
    expect(indicators).toHaveTextContent('Obtidas');
    expect(indicators).toHaveTextContent('Faltantes');
    expect(indicators).toHaveTextContent('Repetidas');
  });
});

describe('carregamento inicial', () => {
  it('mostra o indicador de carregamento até os dados chegarem', async () => {
    let resolveList;
    api.listStickers.mockReturnValue(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );

    render(<App />);
    expect(screen.getByText('Carregando…')).toBeInTheDocument();

    resolveList(stickers);
    await waitFor(() => expect(screen.queryByText('Carregando…')).not.toBeInTheDocument());
  });
});

describe('cadastro de figurinha', () => {
  it('envia os dados do formulário e atualiza a lista', async () => {
    const user = userEvent.setup();
    api.createSticker.mockResolvedValue({});
    await renderAppLoaded();

    const form = screen.getByRole('heading', { name: 'Adicionar figurinha' }).closest('section');

    await user.type(within(form).getByLabelText('Número no álbum'), '42');
    await user.type(within(form).getByLabelText('Nome do jogador'), 'Novo Jogador');
    await user.type(within(form).getByLabelText('País'), 'Alemanha');
    await user.type(within(form).getByLabelText('Código do país'), 'DE');
    await user.click(within(form).getByRole('button', { name: 'Adicionar' }));

    await waitFor(() =>
      expect(api.createSticker).toHaveBeenCalledWith({
        albumNumber: 42,
        playerName: 'Novo Jogador',
        country: 'Alemanha',
        countryCode: 'DE',
        position: 'goalkeeper',
        quantity: 0,
      }),
    );
    await waitFor(() => expect(screen.getByText('Figurinha adicionada.')).toBeInTheDocument());
  });
});

describe('incremento', () => {
  it('chama a API para incrementar a quantidade da figurinha', async () => {
    const user = userEvent.setup();
    api.changeQuantity.mockResolvedValue({});
    await renderAppLoaded();

    const card = getCard('Marcos Vieira');
    await user.click(within(card).getByLabelText('Incrementar'));

    await waitFor(() => expect(api.changeQuantity).toHaveBeenCalledWith('s1', 'increment'));
  });
});

describe('decremento', () => {
  it('chama a API para decrementar a quantidade da figurinha', async () => {
    const user = userEvent.setup();
    api.changeQuantity.mockResolvedValue({});
    await renderAppLoaded();

    const card = getCard('Lucas Ferreira');
    await user.click(within(card).getByLabelText('Decrementar'));

    await waitFor(() => expect(api.changeQuantity).toHaveBeenCalledWith('s3', 'decrement'));
  });
});

describe('filtro de faltantes', () => {
  it('exibe apenas as figurinhas faltantes', async () => {
    const user = userEvent.setup();
    await renderAppLoaded();

    await user.selectOptions(screen.getByLabelText('Situação'), 'missing');

    expect(screen.getByText('Rafael Andrade')).toBeInTheDocument();
    expect(screen.queryByText('Marcos Vieira')).not.toBeInTheDocument();
    expect(screen.queryByText('Lucas Ferreira')).not.toBeInTheDocument();
  });
});

describe('filtro de repetidas', () => {
  it('exibe apenas as figurinhas repetidas', async () => {
    const user = userEvent.setup();
    await renderAppLoaded();

    await user.selectOptions(screen.getByLabelText('Situação'), 'duplicate');

    expect(screen.getByText('Lucas Ferreira')).toBeInTheDocument();
    expect(screen.queryByText('Marcos Vieira')).not.toBeInTheDocument();
    expect(screen.queryByText('Rafael Andrade')).not.toBeInTheDocument();
  });
});

describe('busca por jogador', () => {
  it('filtra a lista pelo nome digitado', async () => {
    const user = userEvent.setup();
    await renderAppLoaded();

    await user.type(screen.getByLabelText('Buscar jogador'), 'lucas');

    expect(screen.getByText('Lucas Ferreira')).toBeInTheDocument();
    expect(screen.queryByText('Marcos Vieira')).not.toBeInTheDocument();
    expect(screen.queryByText('Rafael Andrade')).not.toBeInTheDocument();
  });
});

describe('erro da API', () => {
  it('exibe uma mensagem de erro quando a API falha', async () => {
    api.listStickers.mockRejectedValue(new Error('Falha de conexão'));
    render(<App />);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Falha de conexão'));
  });
});

describe('abertura do relatório', () => {
  it('compartilha o relatório via navigator.share quando disponível', async () => {
    const user = userEvent.setup();
    const shareMock = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { ...navigator, share: shareMock });
    await renderAppLoaded();

    await user.click(screen.getByRole('button', { name: 'Compartilhar relatório' }));

    await waitFor(() => expect(shareMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Relatório compartilhado.')).toBeInTheDocument());

    vi.unstubAllGlobals();
  });
});

describe('cópia do relatório', () => {
  it('copia o relatório para a área de transferência ao clicar em Copiar', async () => {
    const user = userEvent.setup();
    const writeTextMock = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { ...navigator, share: undefined, clipboard: { writeText: writeTextMock } });
    await renderAppLoaded();

    await user.click(screen.getByRole('button', { name: 'Copiar' }));

    await waitFor(() => expect(writeTextMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Relatório copiado.')).toBeInTheDocument());

    vi.unstubAllGlobals();
  });
});
