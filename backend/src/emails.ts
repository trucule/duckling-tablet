// Every email the server sends, in each language Duckling speaks (language.ts). The sign-in emails go out before a
// family exists, so their language comes from the device or browser that asked; the invite uses the family's.
import type { Language } from './language.js';

export interface Email { subject: string; body: string }
const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

// The six-digit code typed into the portal running as an iPhone or iPad home-screen app.
export function portalCodeEmail(lang: Language, code: string): Email {
  const c = spaced(code);
  return lang === 'es'
    ? { subject: `${c} es tu código para entrar a Duckling Tablet`,
        body: `Escribe este código en la app de Duckling de tu pantalla de inicio para entrar:\n\n    ${c}\n\nFunciona una sola vez y vence en 15 minutos. Si no lo pediste, puedes ignorar este correo.` }
    : { subject: `${c} is your Duckling Tablet sign-in code`,
        body: `Type this code in the Duckling app on your home screen to sign in:\n\n    ${c}\n\nIt works once and expires in 15 minutes. If you did not ask for this, you can ignore this email.` };
}

// The sign-in link: from the portal, or from a tablet whose parent sets the family up on a phone or computer.
export function signInLinkEmail(lang: Language, source: 'portal' | 'tablet', link: string): Email {
  if (lang === 'es') return source === 'tablet'
    ? { subject: 'Configura tu familia de Duckling Tablet',
        body: `Empezaste a configurar Duckling Tablet en una tableta. Abre este enlace en tu teléfono o computadora para configurar tu familia; funciona una sola vez y vence en 15 minutos.\n\n${link}\n\nLuego agrega a tu hijo o hija, toca Agregar un dispositivo y escribe en la tableta el código de seis dígitos que aparece.\n\nSi no lo pediste, puedes ignorar este correo.` }
    : { subject: 'Tu enlace para entrar a Duckling Tablet',
        body: `Toca este enlace para entrar a Duckling Tablet. Funciona una sola vez y vence en 15 minutos.\n\n${link}\n\nSi no lo pediste, puedes ignorar este correo.` };
  return source === 'tablet'
    ? { subject: 'Set up your Duckling Tablet family',
        body: `You started setting up Duckling Tablet on a tablet. Open this link on your phone or computer to set up your family; it works once and expires in 15 minutes.\n\n${link}\n\nThen add your child, press Add a device, and type the six-digit code it shows into the tablet.\n\nIf you did not ask for this, you can ignore this email.` }
    : { subject: 'Your Duckling Tablet sign-in link',
        body: `Tap this link to sign in to Duckling Tablet. It works once and expires in 15 minutes.\n\n${link}\n\nIf you did not ask for this, you can ignore this email.` };
}

// The code that finishes setup on the tablet itself.
export function tabletCodeEmail(lang: Language, code: string): Email {
  const c = spaced(code);
  return lang === 'es'
    ? { subject: `${c} es tu código de Duckling Tablet`,
        body: `Escribe este código en la tableta para terminar de configurar Duckling Tablet:\n\n    ${c}\n\nFunciona una sola vez y vence en 10 minutos. Si no lo pediste, puedes ignorar este correo.` }
    : { subject: `${c} is your Duckling Tablet code`,
        body: `Type this code on the tablet to finish setting up Duckling Tablet:\n\n    ${c}\n\nIt works once and expires in 10 minutes. If you did not ask for this, you can ignore this email.` };
}

// A second parent's invite, in the inviting family's language.
export function inviteEmail(lang: Language, from: string, link: string): Email {
  return lang === 'es'
    ? { subject: 'Te invitaron a una familia de Duckling Tablet',
        body: `${from} te invitó a administrar las tabletas Duckling de su familia. Abre este enlace para unirte; funciona una sola vez y vence en 7 días.\n\n${link}\n\nSi no esperabas esto, puedes ignorar este correo.` }
    : { subject: 'You are invited to a Duckling Tablet family',
        body: `${from} invited you to manage their family's Duckling tablets. Open this link to join; it works once and expires in 7 days.\n\n${link}\n\nIf you were not expecting this, you can ignore this email.` };
}
