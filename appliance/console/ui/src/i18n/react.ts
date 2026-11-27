import { createContext, useContext } from 'react';
import { english } from './translate';

export const Translation = createContext(english);
export const useT = () => useContext(Translation);
