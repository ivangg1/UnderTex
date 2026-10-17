// Project templates used by "New project". Language-neutral LaTeX; names and
// descriptions are translated through i18n keys.

import type { MessageKey } from "../i18n";

export interface TemplateFile {
  path: string;
  content: string;
}

export interface ProjectTemplate {
  id: string;
  nameKey: MessageKey;
  descriptionKey: MessageKey;
  files: TemplateFile[];
}

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: "blank",
    nameKey: "template.blank",
    descriptionKey: "template.blank.desc",
    files: [
      {
        path: "main.tex",
        content: `\\documentclass{article}
\\begin{document}

\\end{document}
`,
      },
    ],
  },
  {
    id: "article",
    nameKey: "template.article",
    descriptionKey: "template.article.desc",
    files: [
      {
        path: "main.tex",
        content: `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Title}
\\author{Author}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
Abstract.
\\end{abstract}

\\section{Introduction}
Text. See Section~\\ref{sec:method} and~\\cite{knuth1984}.

\\section{Method}
\\label{sec:method}
\\begin{equation}
  E = mc^2
\\end{equation}

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`,
      },
      {
        path: "refs.bib",
        content: `@article{knuth1984,
  author  = {Donald E. Knuth},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  year    = {1984},
  volume  = {27},
  number  = {2},
  pages   = {97--111}
}
`,
      },
    ],
  },
  {
    id: "report",
    nameKey: "template.report",
    descriptionKey: "template.report.desc",
    files: [
      {
        path: "main.tex",
        content: `\\documentclass[12pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{Report title}
\\author{Author}

\\begin{document}
\\maketitle
\\tableofcontents

\\input{chapters/introduction}
\\input{chapters/conclusion}

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`,
      },
      {
        path: "chapters/introduction.tex",
        content: `\\chapter{Introduction}
Text. See~\\cite{knuth1984}.
`,
      },
      {
        path: "chapters/conclusion.tex",
        content: `\\chapter{Conclusion}
Text.
`,
      },
      {
        path: "refs.bib",
        content: `@article{knuth1984,
  author  = {Donald E. Knuth},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  year    = {1984},
  volume  = {27},
  number  = {2},
  pages   = {97--111}
}
`,
      },
    ],
  },
  {
    id: "beamer",
    nameKey: "template.beamer",
    descriptionKey: "template.beamer.desc",
    files: [
      {
        path: "main.tex",
        content: `\\documentclass{beamer}
\\usetheme{metropolis}
\\usepackage[utf8]{inputenc}

\\title{Presentation}
\\author{Author}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Introduction}
\\begin{frame}{Introduction}
  \\begin{itemize}
    \\item First point
    \\item Second point
  \\end{itemize}
\\end{frame}

\\end{document}
`,
      },
    ],
  },
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
