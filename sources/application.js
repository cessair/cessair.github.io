import React from 'react';
import ReactDOM from 'react-dom';
import { renderRoutes } from 'react-router-config';
import { BrowserRouter as Router } from 'react-router-dom';
import Routes from './routing';

ReactDOM.render(
    React.createElement(Router, {}, renderRoutes(Routes)),
    document.querySelector('#context')
);
