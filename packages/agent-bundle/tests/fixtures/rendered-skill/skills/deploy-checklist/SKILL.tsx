/**
 * A rendered skill: the component tree below compiles to the SKILL.md this
 * directory ships. The frontmatter export carries the document metadata.
 */

interface StepProps {
  readonly detail: string;
  readonly title: string;
}

const Step = ({ detail, title }: StepProps) => (
  <li>
    <strong>{title}</strong> — {detail}
  </li>
);

export const frontmatter = {
  description: 'Walks a release through the deploy checklist with rendered, data-driven steps.',
  name: 'deploy-checklist',
};

const steps: readonly StepProps[] = [
  { detail: 'Green build on main.', title: 'CI' },
  { detail: 'Changelog covers every merged PR.', title: 'Notes' },
];

export default function DeployChecklist() {
  return (
    <>
      <h1>Deploy checklist</h1>
      <p>
        Run every step <em>in order</em>; the playbook in{' '}
        <a href="references/playbook.md">references/playbook.md</a> has the details.
      </p>
      <ol>
        {steps.map((step) => (
          <Step detail={step.detail} key={step.title} title={step.title} />
        ))}
      </ol>
      <pre>
        <code className="language-sh">{'agent-bundle build\n'}</code>
      </pre>
      <blockquote>
        <p>Ship only when the checklist is green.</p>
      </blockquote>
    </>
  );
}
