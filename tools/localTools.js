'use strict';

function createEchoTool() {
  return {
    invoke: async (input) => {
      const text = input && typeof input.text === 'string' ? input.text : '';
      return JSON.stringify({
        echoed: text,
        from: 'spilli-coder-local-tool'
      });
    }
  };
}

const toolModule = {
  id: 'spilli-coder-local-tools',
  tools: [
    {
      contract: {
        name: 'agent.echo',
        description: 'Echoes provided text for external runtime validation.',
        args: '{"text": string}',
        returns: '{"echoed": string, "from": string}',
        includeByDefault: true,
        keywords: ['echo', 'external agent', 'test']
      },
      createTool: createEchoTool
    }
  ]
};

module.exports = {
  default: toolModule,
  toolModule
};
